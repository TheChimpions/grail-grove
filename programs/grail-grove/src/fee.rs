use anchor_lang::prelude::*;

use crate::errors::GrailGroveError;
use crate::state::BPS_DENOMINATOR;

/// Split a flat fee into (treasury_share, lister_share). Rounding dust goes
/// to the lister so the two parts always sum to `fee`.
pub fn split_fee(fee: u64, treasury_bps: u16) -> Result<(u64, u64)> {
    require!(treasury_bps <= BPS_DENOMINATOR, GrailGroveError::InvalidBps);
    let treasury = (fee as u128)
        .checked_mul(treasury_bps as u128)
        .ok_or(GrailGroveError::MathOverflow)?
        / BPS_DENOMINATOR as u128;
    let treasury = u64::try_from(treasury).map_err(|_| GrailGroveError::MathOverflow)?;
    let lister = fee
        .checked_sub(treasury)
        .ok_or(GrailGroveError::MathOverflow)?;
    Ok((treasury, lister))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_evenly() {
        assert_eq!(split_fee(1_000_000, 5_000).unwrap(), (500_000, 500_000));
    }

    #[test]
    fn dust_goes_to_lister() {
        // 3333 bps of 1000 = 333.3 → treasury 333, lister 667
        assert_eq!(split_fee(1_000, 3_333).unwrap(), (333, 667));
    }

    #[test]
    fn all_to_treasury() {
        assert_eq!(split_fee(777, 10_000).unwrap(), (777, 0));
    }

    #[test]
    fn all_to_lister() {
        assert_eq!(split_fee(777, 0).unwrap(), (0, 777));
    }

    #[test]
    fn zero_fee() {
        assert_eq!(split_fee(0, 5_000).unwrap(), (0, 0));
    }

    #[test]
    fn rejects_bps_over_100_percent() {
        assert!(split_fee(1_000, 10_001).is_err());
    }

    #[test]
    fn max_u64_does_not_overflow() {
        let (t, l) = split_fee(u64::MAX, 10_000).unwrap();
        assert_eq!(t, u64::MAX);
        assert_eq!(l, 0);
    }
}
