// Host check of the charge current's taper (no board needed):
//   g++ -std=c++17 -I firmware/common/src firmware/common/test/charge_taper_test.cpp -o /tmp/charge_taper_test && /tmp/charge_taper_test
#include <cmath>
#include <cstdio>

#include "charge_taper.h"

static int failed = 0;

static void expect(int got, int want, const char *what) {
    if (got != want) {
        std::printf("FAIL %s: got %d, want %d\n", what, got, want);
        failed++;
    }
}

int main() {
    using namespace power;
    // Where the steps begin: 60, 70, 76 at a limit of 80; 75, 87, 95 without one.
    expect(taperStart(1, 80), 60, "80: 50% from 60");
    expect(taperStart(2, 80), 70, "80: 25% from 70");
    expect(taperStart(3, 80), 76, "80: 10% from 76");
    expect(taperStepFor(59, 80), 0, "80: 59 full");
    expect(taperStepFor(60, 80), 1, "80: 60 half");
    expect(taperStepFor(69, 80), 1, "80: 69 half");
    expect(taperStepFor(70, 80), 2, "80: 70 quarter");
    expect(taperStepFor(76, 80), 3, "80: 76 tenth");
    expect(taperStepFor(74, 100), 0, "none: 74 full");
    expect(taperStepFor(75, 100), 1, "none: 75 half");
    expect(taperStepFor(87, 100), 1, "none: 87 still half (87.5)");
    expect(taperStepFor(88, 100), 2, "none: 88 quarter");
    expect(taperStepFor(95, 100), 3, "none: 95 tenth");
    expect(taperStepFor(99, 120), 3, "above 100 is none");
    expect(taperStepFor(68, 90), 1, "90: 67.5 starts half");

    // The current for each step, 1000 mA asked.
    Taper t;
    const float cool = 30.0f;
    taperUpdate(t, true, true, 40, 80, true, cool);
    expect(taperMa(t, 1000), 1000, "40% full");
    taperUpdate(t, true, true, 61, 80, true, cool);
    expect(taperMa(t, 1000), 500, "61% half");
    // The gauge drops back when the current falls: no flap back up while charging.
    taperUpdate(t, true, true, 57, 80, true, cool);
    expect(taperMa(t, 1000), 500, "57% while charging stays half");
    taperUpdate(t, true, true, 72, 80, true, cool);
    expect(taperMa(t, 1000), 250, "72% quarter");
    taperUpdate(t, true, true, 77, 80, true, cool);
    expect(taperMa(t, 1000), 100, "77% tenth");
    // Held at 80 and drifting: not charging, relaxes only 2 below the step's start.
    taperUpdate(t, true, true, 80, 80, false, cool);
    taperUpdate(t, true, true, 75, 80, false, cool);
    expect(t.step, 3, "held, 75 stays tenth (76 - 2 not reached)");
    taperUpdate(t, true, true, 74, 80, false, cool);
    expect(t.step, 2, "not charging at 74 relaxes to quarter");
    // USB pulled: from nothing again.
    taperUpdate(t, true, false, 74, 80, false, cool);
    expect(t.step, 0, "USB gone resets");
    taperUpdate(t, true, true, 74, 80, true, cool);
    expect(t.step, 2, "plugged in at 74: quarter at once");
    // A new limit: worked out again, here up.
    taperUpdate(t, true, true, 74, 100, true, cool);
    expect(t.step, 0, "limit lifted to 100: 74 full");
    // No battery or unknown percent: reset.
    taperUpdate(t, false, true, 74, 100, true, cool);
    expect(t.step, 0, "no battery");
    expect(t.limit, -1, "no battery forgets the limit");

    // Heat: one step above 40 C, two above 50 C, back 3 C lower.
    expect(taperHot(40.0f, 0), 0, "40 C is not hot");
    expect(taperHot(40.5f, 0), 1, "40.5 C hot");
    expect(taperHot(51.0f, 0), 2, "51 C hotter");
    expect(taperHot(48.0f, 2), 2, "48 C stays hotter");
    expect(taperHot(47.0f, 2), 1, "47 C back to hot");
    expect(taperHot(38.0f, 1), 1, "38 C stays hot");
    expect(taperHot(37.0f, 1), 0, "37 C cool");
    expect(taperHot(30.0f, 2), 0, "30 C from hotter to cool");
    expect(taperHot(NAN, 1), 1, "unknown keeps it");
    Taper h;
    taperUpdate(h, true, true, 40, 100, true, 45.0f);
    expect(taperMa(h, 1000), 500, "40% at 45 C: half");
    taperUpdate(h, true, true, 40, 100, true, 55.0f);
    expect(taperMa(h, 1000), 250, "40% at 55 C: quarter");
    taperUpdate(h, true, true, 96, 100, true, 55.0f);
    expect(taperMa(h, 1000), 100, "96% at 55 C: never below a tenth");

    // The setting is clamped: 1000 at most.
    Taper f;
    taperUpdate(f, true, true, 10, 100, true, cool);
    expect(taperMa(f, 2000), 1000, "2000 asked: 1000");
    expect(taperMa(f, 500), 500, "500 asked");

    // The chip's codes, rounded down.
    expect(chargeCurrentCode(1000), 16, "1000 mA");
    expect(chargeCurrentCode(1500), 16, "above 1000");
    expect(chargeCurrentCode(999), 15, "999 rounds to 900");
    expect(chargeCurrentCode(500), 11, "500 mA");
    expect(chargeCurrentCode(300), 9, "300 mA");
    expect(chargeCurrentCode(299), 8, "299 rounds to 200");
    expect(chargeCurrentCode(250), 8, "250 rounds to 200");
    expect(chargeCurrentCode(200), 8, "200 mA");
    expect(chargeCurrentCode(125), 5, "125 mA");
    expect(chargeCurrentCode(100), 4, "100 mA");
    expect(chargeCurrentCode(99), 3, "99 rounds to 75");
    expect(chargeCurrentCode(10), 1, "never below 25");
    expect(chargeCurrentMaOf(16), 1000, "16 is 1000");
    expect(chargeCurrentMaOf(9), 300, "9 is 300");
    expect(chargeCurrentMaOf(8), 200, "8 is 200");
    expect(chargeCurrentMaOf(4), 100, "4 is 100");
    expect(chargeCurrentMaOf(20), 0, "unlisted code");
    for (int c = 1; c <= 16; c++) expect(chargeCurrentCode(chargeCurrentMaOf(c)), c, "code round trip");

    std::printf(failed ? "%d failed\n" : "charge taper: all passed\n", failed);
    return failed ? 1 : 0;
}
