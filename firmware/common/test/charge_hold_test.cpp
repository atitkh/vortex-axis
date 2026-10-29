// Host check of the charge limit's hold rule (no board needed):
//   g++ -std=c++17 -I firmware/common/src firmware/common/test/charge_hold_test.cpp -o /tmp/charge_hold_test && /tmp/charge_hold_test
#include <cstdio>

#include "charge_hold.h"

static int failed = 0;

static void expect(bool got, bool want, const char *what) {
    if (got != want) {
        std::printf("FAIL %s: got %d, want %d\n", what, got, want);
        failed++;
    }
}

int main() {
    using power::chargeHeld;
    // No limit, no battery, no USB, unknown percent: never held, whatever it was.
    expect(chargeHeld(true, true, 90, 100, true), false, "limit 100 lifts a hold");
    expect(chargeHeld(true, true, 90, 120, false), false, "above 100 is no limit");
    expect(chargeHeld(false, true, 90, 80, true), false, "no battery");
    expect(chargeHeld(true, false, 90, 80, true), false, "USB removed");
    expect(chargeHeld(true, true, -1, 80, true), false, "unknown percent");
    // At or above the limit: held.
    expect(chargeHeld(true, true, 80, 80, false), true, "at the limit");
    expect(chargeHeld(true, true, 85, 80, false), true, "above the limit");
    // Between limit - 5 and the limit: as it was.
    expect(chargeHeld(true, true, 78, 80, true), true, "78 stays held");
    expect(chargeHeld(true, true, 76, 80, false), false, "76 stays charging");
    // At or below limit - 5: charging again.
    expect(chargeHeld(true, true, 75, 80, true), false, "75 resumes");
    expect(chargeHeld(true, true, 40, 50, true), false, "below 45 resumes");
    // A full run: charge up to 80, drift down to 75, charge again.
    bool held = false;
    for (int p = 70; p <= 80; p++) held = chargeHeld(true, true, p, 80, held);
    expect(held, true, "run up to 80");
    for (int p = 79; p >= 76; p--) held = chargeHeld(true, true, p, 80, held);
    expect(held, true, "drift to 76");
    held = chargeHeld(true, true, 75, 80, held);
    expect(held, false, "drift to 75");
    std::printf(failed ? "%d failed\n" : "charge hold: all passed\n", failed);
    return failed ? 1 : 0;
}
