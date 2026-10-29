#pragma once
// The charge limit's hold rule, kept free of the chip so it can be checked on a computer
// (firmware/common/test/charge_hold_test.cpp). axis_power applies what it returns.

namespace power {

const int CHARGE_LIMIT_OFF = 100;    // 100 (or anything above) means no limit
const int CHARGE_LIMIT_MIN = 50;
const int CHARGE_RESUME_BELOW = 5;   // a hold ends this many percent below the limit

/** Whether charging stays held off: true at or above the limit, false at or below limit - 5, as it was in
 *  between. Never held without a battery, without USB, with an unknown percent or without a limit. */
inline bool chargeHeld(bool battery, bool usb, int percent, int limit, bool heldNow) {
    if (!battery || !usb || percent < 0 || limit >= CHARGE_LIMIT_OFF) return false;
    if (percent >= limit) return true;
    if (percent <= limit - CHARGE_RESUME_BELOW) return false;
    return heldNow;
}

}  // namespace power
