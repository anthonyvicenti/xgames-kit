//! The pieces of arithmetic: a weighted pick for box rolls, a weight that shrinks with stock,
//! and a share of a payment.
/// Weighted pick over the entries that are still available. `None` when nothing is available.
/// Pure so it can be unit tested and mirrored exactly by the TypeScript odds display.
pub fn pick(weights: &[(u32, bool)], roll: u64) -> Option<usize> {
    let total: u64 = weights
        .iter()
        .filter(|(_, ok)| *ok)
        .map(|(w, _)| *w as u64)
        .sum();
    if total == 0 {
        return None;
    }
    let mut r = roll % total;
    for (i, (w, ok)) in weights.iter().enumerate() {
        if !*ok {
            continue;
        }
        let w = *w as u64;
        if r < w {
            return Some(i);
        }
        r -= w;
    }
    None
}

/// `weight` scaled by the share of an item's supply still left, rounded up, so the last one
/// can still be won. An item with no supply limit keeps its weight.
pub fn by_stock(weight: u32, max_supply: u32, out: u32) -> u32 {
    if max_supply == 0 {
        return weight;
    }
    let left = max_supply.saturating_sub(out) as u64;
    let max = max_supply as u64;
    ((weight as u64 * left).div_ceil(max)) as u32
}

/// `amount * bps / 10_000`, rounded down, in 64-bit arithmetic (a 128-bit division costs
/// about 5 KB of program and several hundred compute units on SBF). Exact: with
/// `amount = q * 10_000 + r`, the result is `q * bps + r * bps / 10_000`.
pub fn share(amount: u64, bps: u16) -> Option<u64> {
    const BPS: u64 = crate::constants::BPS;
    let whole = (amount / BPS).checked_mul(bps as u64)?;
    whole.checked_add((amount % BPS) * bps as u64 / BPS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_by_weight() {
        let w = [(70, true), (25, true), (5, true)];
        assert_eq!(pick(&w, 0), Some(0));
        assert_eq!(pick(&w, 69), Some(0));
        assert_eq!(pick(&w, 70), Some(1));
        assert_eq!(pick(&w, 94), Some(1));
        assert_eq!(pick(&w, 95), Some(2));
        assert_eq!(pick(&w, 99), Some(2));
        assert_eq!(pick(&w, 100), Some(0));
    }

    #[test]
    fn skips_sold_out() {
        let w = [(70, false), (25, true), (5, true)];
        assert_eq!(pick(&w, 0), Some(1));
        assert_eq!(pick(&w, 25), Some(2));
        assert_eq!(pick(&[(1, false)], 7), None);
        assert_eq!(pick(&[], 7), None);
    }

    #[test]
    fn distribution_matches_weights() {
        let w = [(60, true), (30, true), (10, true)];
        let mut hits = [0u32; 3];
        for r in 0..10_000u64 {
            hits[pick(&w, r.wrapping_mul(0x9E37_79B9_7F4A_7C15)).unwrap()] += 1;
        }
        assert_eq!(hits.iter().sum::<u32>(), 10_000);
        assert!((5_700..6_300).contains(&hits[0]));
        assert!((2_700..3_300).contains(&hits[1]));
        assert!((800..1_200).contains(&hits[2]));
    }

    #[test]
    fn a_weight_shrinks_with_stock() {
        assert_eq!(by_stock(1_000, 0, 50), 1_000, "no limit, no change");
        assert_eq!(by_stock(1_000, 100, 0), 1_000);
        assert_eq!(by_stock(1_000, 100, 50), 500);
        assert_eq!(by_stock(1_000, 100, 99), 10);
        assert_eq!(by_stock(1, 100, 99), 1, "the last one can still be won");
        assert_eq!(by_stock(1_000, 100, 100), 0);
        assert_eq!(by_stock(u32::MAX, u32::MAX, 0), u32::MAX);
    }

    #[test]
    fn share_equals_the_128_bit_formula() {
        let wide = |amount: u64, bps: u16| (amount as u128 * bps as u128 / 10_000) as u64;
        let amounts = [0, 1, 7, 19, 20, 9_999, 10_000, 10_001, 1_000_000, 123_456_789_012, u64::MAX / 3, u64::MAX - 1, u64::MAX];
        for amount in amounts {
            for bps in [0u16, 1, 49, 500, 999, 1_000, 2_000, 5_000, 9_000, 9_999, 10_000] {
                assert_eq!(share(amount, bps), Some(wide(amount, bps)), "{amount} at {bps}");
            }
        }
        let mut x = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..20_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let bps = (x % 10_001) as u16;
            assert_eq!(share(x, bps), Some(wide(x, bps)));
        }
    }
}
