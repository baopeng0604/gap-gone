//! ITU-R BS.1770-4 Integrated loudness（LUFS）。
//! 与前端 `src/utils/lufs.ts` 同一套 K 计权 + 门限。

const BLOCK_SEC: f64 = 0.4;
const HOP_SEC: f64 = 0.1;
const ABSOLUTE_GATE: f64 = -70.0;
const RELATIVE_OFFSET: f64 = -10.0;
const LOUDNESS_OFFSET: f64 = -0.691;

struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl Biquad {
    fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

fn k_weight_filters(sample_rate: f64) -> (Biquad, Biquad) {
    let shelf_db = 3.999843853973347;
    let shelf_f0 = 1681.974450955533;
    let shelf_q = 0.7071752369554196;
    let shelf_k = (std::f64::consts::PI * shelf_f0 / sample_rate).tan();
    let vh = 10f64.powf(shelf_db / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let mut a0 = 1.0 + shelf_k / shelf_q + shelf_k * shelf_k;
    let pre = Biquad {
        b0: (vh + vb * shelf_k / shelf_q + shelf_k * shelf_k) / a0,
        b1: (2.0 * (shelf_k * shelf_k - vh)) / a0,
        b2: (vh - vb * shelf_k / shelf_q + shelf_k * shelf_k) / a0,
        a1: (2.0 * (shelf_k * shelf_k - 1.0)) / a0,
        a2: (1.0 - shelf_k / shelf_q + shelf_k * shelf_k) / a0,
        z1: 0.0,
        z2: 0.0,
    };

    let rlb_f0 = 38.13547087613982;
    let rlb_q = 0.5003270373238773;
    let rlb_k = (std::f64::consts::PI * rlb_f0 / sample_rate).tan();
    a0 = 1.0 + rlb_k / rlb_q + rlb_k * rlb_k;
    let rlb = Biquad {
        b0: 1.0 / a0,
        b1: -2.0 / a0,
        b2: 1.0 / a0,
        a1: (2.0 * (rlb_k * rlb_k - 1.0)) / a0,
        a2: (1.0 - rlb_k / rlb_q + rlb_k * rlb_k) / a0,
        z1: 0.0,
        z2: 0.0,
    };
    (pre, rlb)
}

fn loudness_from_mean_square(mean_square: f64) -> f64 {
    if mean_square > 0.0 {
        LOUDNESS_OFFSET + 10.0 * mean_square.log10()
    } else {
        f64::NEG_INFINITY
    }
}

/// 单声道流式 Integrated LUFS。录音写入线程按块喂入。
pub struct IntegratedLoudness {
    pre: Biquad,
    rlb: Biquad,
    hop_len: usize,
    hops_per_block: usize,
    pending: Vec<f64>,
    hop_mean_squares: Vec<f64>,
    block_mean_squares: Vec<f64>,
}

impl IntegratedLoudness {
    pub fn new(sample_rate: u32) -> Self {
        let (pre, rlb) = k_weight_filters(sample_rate as f64);
        Self {
            pre,
            rlb,
            hop_len: ((sample_rate as f64) * HOP_SEC).round().max(1.0) as usize,
            hops_per_block: (BLOCK_SEC / HOP_SEC).round().max(1.0) as usize,
            pending: Vec::new(),
            hop_mean_squares: Vec::new(),
            block_mean_squares: Vec::new(),
        }
    }

    pub fn push_mono(&mut self, samples: &[f32]) {
        self.pending.reserve(samples.len());
        for sample in samples {
            let weighted = self.rlb.process(self.pre.process(*sample as f64));
            self.pending.push(weighted);
        }
        while self.pending.len() >= self.hop_len {
            let mean_square = self.pending[..self.hop_len]
                .iter()
                .map(|sample| sample * sample)
                .sum::<f64>()
                / self.hop_len as f64;
            self.pending.drain(..self.hop_len);
            self.hop_mean_squares.push(mean_square);
            if self.hop_mean_squares.len() >= self.hops_per_block {
                let start = self.hop_mean_squares.len() - self.hops_per_block;
                let block = self.hop_mean_squares[start..].iter().sum::<f64>()
                    / self.hops_per_block as f64;
                self.block_mean_squares.push(block);
            }
        }
    }

    pub fn integrated(&self) -> Option<f32> {
        if self.block_mean_squares.is_empty() {
            return None;
        }
        let above_absolute: Vec<f64> = self
            .block_mean_squares
            .iter()
            .copied()
            .filter(|mean_square| loudness_from_mean_square(*mean_square) > ABSOLUTE_GATE)
            .collect();
        if above_absolute.is_empty() {
            return None;
        }
        let gated_mean = above_absolute.iter().sum::<f64>() / above_absolute.len() as f64;
        let relative = loudness_from_mean_square(gated_mean) + RELATIVE_OFFSET;
        let above_relative: Vec<f64> = above_absolute
            .into_iter()
            .filter(|mean_square| loudness_from_mean_square(*mean_square) > relative)
            .collect();
        if above_relative.is_empty() {
            return None;
        }
        let final_mean = above_relative.iter().sum::<f64>() / above_relative.len() as f64;
        let lufs = loudness_from_mean_square(final_mean);
        lufs.is_finite().then_some(lufs as f32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_has_no_integrated_loudness() {
        let mut meter = IntegratedLoudness::new(48_000);
        meter.push_mono(&[0.0; 48_000]);
        assert_eq!(meter.integrated(), None);
    }

    #[test]
    fn full_scale_sine_is_finite_and_loud() {
        let sample_rate = 48_000u32;
        let mut samples = vec![0.0f32; sample_rate as usize];
        for (index, sample) in samples.iter_mut().enumerate() {
            let t = index as f32 / sample_rate as f32;
            *sample = (2.0 * std::f32::consts::PI * 1000.0 * t).sin();
        }
        let mut meter = IntegratedLoudness::new(sample_rate);
        meter.push_mono(&samples);
        let lufs = meter.integrated().expect("1s sine should produce LUFS");
        // 0 dBFS 1 kHz 正弦，K 计权后大约 -3 LUFS 量级，绝不应偏弱到 -16 以下。
        assert!(lufs > -8.0 && lufs < 0.0, "unexpected LUFS {lufs}");
    }
}
