#pragma once

// The default face: a vortex of dots on spiral arms. It spins slowly when
// idle, pulls inward to listen, speeds up to think and pulses to speak.
//
// It is drawn into its own square buffer and never touches the panel; the
// caller sends the buffer to the display.
//
// Specified in docs/face.md, which web/vortex.js also follows. Change all three together.

#include <Arduino.h>

namespace vortex {

/**
 * Side of the square the face is drawn in, in pixels. A board with a bigger screen sets VORTEX_SIZE in its
 * build flags; the whole face (dots, wander, core, icons) is then drawn to scale, as specified for 240.
 */
#ifndef VORTEX_SIZE
#define VORTEX_SIZE 240
#endif
const int SIZE = VORTEX_SIZE;
/** How much bigger than the specification's 240 the face is drawn. */
const float SCALE = SIZE / 240.0f;
/**
 * The biggest it may be drawn (setSize), which is what the buffer is made for. A board that changes the face's
 * size as it goes sets VORTEX_MAX_SIZE; otherwise it is always SIZE.
 */
#ifndef VORTEX_MAX_SIZE
#define VORTEX_MAX_SIZE VORTEX_SIZE
#endif
const int MAX_SIZE = VORTEX_MAX_SIZE;

/** A part of the frame, from (x0, y0) up to but not including (x1, y1). */
struct Box {
    int x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    bool empty() const { return x1 <= x0 || y1 <= y0; }
};

enum class Mode : uint8_t { Setup, Offline, Idle, Listening, Thinking, Speaking, Error };

/** Allocates the buffer. False when there is no memory for it. */
bool begin();

/**
 * Draws from the next frame on in a square `pixels` wide (even, up to MAX_SIZE; SIZE until called), everything in it
 * to that scale. The frame's rows are then that long.
 */
void setSize(int pixels);
int size();

/**
 * With this on, a frame blacks out only what the one before drew instead of the whole square. Off by default: a
 * caller that lays anything else into the frame must then black it out again itself.
 */
void setLazyClear(bool on);
/** The part of the last frame that the face drew on; all of the rest is black. */
Box drawn();
/** With lazy clearing on: the part of row `y` of the last frame the face drew on, x0 up to x1. False when none. */
bool drawnRow(int y, int &x0, int &x1);
/** Diagnostics: the farthest the figure has reached from the middle of its square, in pixels, since this was last asked. */
float farthest();

void setMode(Mode mode);

/**
 * What Axis says the agent is doing while it thinks: a kind of tool (shown as an icon, see setIcon), a
 * reason its run is held up ("compacting", "retrying": shown as a look of its own, with no icon), or
 * nothing, which is plain thinking. Call it after setMode.
 */
void setDoing(const char *name);

/**
 * The kind of work to show in the middle while thinking (a name from icons.h), or nothing for
 * null, an empty name or one this face has no icon for.
 */
void setIcon(const char *name);

/** How an icon is shown while thinking: not at all, drawn with a pen at the core, or made of the face's own dots. */
enum class IconStyle : uint8_t { Off, Line, Dots };

/** The `toolIcons` setting: "off", "line" or "dots". Anything else, or nothing, is dots. */
void setIconStyle(const char *name);

/**
 * How long an icon takes to form and to go, in milliseconds (the `toolIconMs` setting), and how many of
 * the dots draw a dot shape (`toolIconDots`): the rest turn in a ring round it. Out of range is brought in.
 */
void setIconTuning(int ms, int dots);

/**
 * Which way up the screen is: 0, 90, 180 or 270, as the display is turned. The vortex is round and
 * is sent to the panel as it is, whatever the rotation; an icon has a top, so it is turned to match.
 */
void setRotation(int degrees);

/** Loudness of the voice being played, 0 to 1. Negative means "not known": the face pulses on its own. */
void setLevel(float level);

/** Idle looks to leave out: their names separated by commas, as the `idleLooksOff` setting holds them. */
void setIdleOff(const char *names);

/** Advances the animation by `seconds` and draws a frame. */
const uint16_t *render(float seconds);

/** Name of the idle animation currently playing, for logs. */
const char *idleName();

}  // namespace vortex
