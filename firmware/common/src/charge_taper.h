#pragma once
// The charge current's taper, kept free of the chip so it can be checked on a computer
// (firmware/common/test/charge_taper_test.cpp). axis_power writes what it returns to the AXP2101.
//
// The steps are fractions of the charge limit L in force (100 when there is none): up to 0.75 L the full
// `chargeCurrent`, then 50 % of it, from 0.875 L 25 %, from 0.95 L 10 %; at L the hold (charge_hold.h) stops
// charging. At L = 80 the steps begin at 60, 70 and 76 %. While charging a step only goes down (the fuel gauge
// jumps when the current changes, and a step must not flap with it); it is worked out afresh when USB or the
// battery goes away, at a start and when the limit changes, and while not charging (held, or drained on USB)
// it relaxes once the percent is 2 below the step's start. The power chip's own temperature takes one step more
// above 40 C and two above 50 C, each until it is 3 C cooler. There is no cold guard: the chip's die
// temperature says little about the cell's, and the boards have no battery temperature input.

#include <cmath>

namespace power {

const int CHARGE_CURRENT_MAX_MA = 1000;  // the AXP2101's highest (and 1C for the boards' 1000 mAh cell)
const int CHARGE_CURRENT_MIN_MA = 25;    // the lowest step written while charging; stopping is the hold's job
const int TAPER_RELAX_BELOW = 2;         // percent under a step's start before it relaxes (only while not charging)
const float TAPER_HOT_C = 40.0f, TAPER_HOTTER_C = 50.0f, TAPER_COOL_BY_C = 3.0f;

const int TAPER_STEPS = 4;
// A step's start in thousandths of the limit, and its share of chargeCurrent in percent.
const int TAPER_START[TAPER_STEPS] = {0, 750, 875, 950};
const int TAPER_SHARE[TAPER_STEPS] = {100, 50, 25, 10};

struct Taper {
    int step = 0;      // 0 full .. 3 ten percent, from the battery's level
    int hot = 0;       // 0, 1 or 2 more steps for the chip's heat
    int limit = -1;    // the limit the step was worked out for; -1 until there is one
};

/** The percent at which `step` begins under `limit` (100 or more = none), rounded down. */
inline int taperStart(int step, int limit) {
    const int l = limit >= 100 ? 100 : limit;
    return TAPER_START[step] * l / 1000;
}

/** The step the battery's level asks for, from nothing. */
inline int taperStepFor(int percent, int limit) {
    int s = 0;
    const int l = limit >= 100 ? 100 : limit;
    for (int i = 1; i < TAPER_STEPS; i++) {
        if (percent * 1000 >= TAPER_START[i] * l) s = i;
    }
    return s;
}

/** The heat level after `tempC` (NAN when not known: no change but no new level either). */
inline int taperHot(float tempC, int hotNow) {
    if (std::isnan(tempC)) return hotNow;
    int h = hotNow;
    if (tempC > TAPER_HOTTER_C) h = 2;
    else if (tempC > TAPER_HOT_C && h < 1) h = 1;
    if (h == 2 && tempC <= TAPER_HOTTER_C - TAPER_COOL_BY_C) h = 1;
    if (h == 1 && tempC <= TAPER_HOT_C - TAPER_COOL_BY_C) h = 0;
    return h;
}

/** Moves the taper on by one reading. Without a battery, without USB or with an unknown percent it starts again. */
inline void taperUpdate(Taper &t, bool battery, bool usb, int percent, int limit, bool charging, float tempC) {
    if (!battery || !usb || percent < 0) {
        t = Taper();
        return;
    }
    const int l = limit >= 100 ? 100 : limit;
    const int want = taperStepFor(percent, l);
    if (t.limit != l) {
        t.step = want;
        t.limit = l;
    } else if (want > t.step) {
        t.step = want;
    } else if (!charging && want < t.step && percent <= taperStart(t.step, l) - TAPER_RELAX_BELOW) {
        t.step = want;
    }
    t.hot = taperHot(tempC, t.hot);
}

/** The current to charge at, in mA, for `maxMa` (the `chargeCurrent` setting): the step and heat applied. */
inline int taperMa(const Taper &t, int maxMa) {
    const int m = maxMa > CHARGE_CURRENT_MAX_MA ? CHARGE_CURRENT_MAX_MA : maxMa < CHARGE_CURRENT_MIN_MA ? CHARGE_CURRENT_MIN_MA : maxMa;
    int s = t.step + t.hot;
    if (s >= TAPER_STEPS) s = TAPER_STEPS - 1;
    return m * TAPER_SHARE[s] / 100;
}

/** The AXP2101's code for `ma` (register 0x62 bits 4..0), rounded down to a step it has: 25 mA steps up to
 *  200 mA (codes 0 to 8), then 100 mA steps to 1000 mA (9 = 300 mA .. 16 = 1000 mA). Never below 25 mA. */
inline int chargeCurrentCode(int ma) {
    if (ma >= CHARGE_CURRENT_MAX_MA) return 16;
    if (ma >= 300) return 9 + (ma - 300) / 100;
    if (ma >= 200) return 8;
    if (ma < CHARGE_CURRENT_MIN_MA) return 1;
    return ma / 25;
}

/** The mA a code stands for (0 for codes the chip does not list). */
inline int chargeCurrentMaOf(int code) {
    if (code <= 8) return code * 25;
    if (code <= 16) return 300 + (code - 9) * 100;
    return 0;
}

}  // namespace power
