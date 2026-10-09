#import <CoreGraphics/CoreGraphics.h>

// An invisible display, the mechanism behind Screen Sharing's headless sessions.
// Windows placed on it render, keep their accessibility tree and take input,
// while nobody sees them. CGVirtualDisplay is private API, resolved at runtime:
// when it is missing, create returns 0 and callers report that instead.

/// Create a display of `width` x `height` points. Returns its id, or 0.
CGDirectDisplayID MCUVirtualDisplayCreate(const char *name, uint32_t width, uint32_t height);

/// Remove a display made by MCUVirtualDisplayCreate.
void MCUVirtualDisplayDestroy(CGDirectDisplayID display);
