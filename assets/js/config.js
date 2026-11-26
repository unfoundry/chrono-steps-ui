/**
 * Chrono Steps — Runtime Configuration
 * Adjust visual cue timing, fade animation, branding, and video duration limits here.
 */
window.ChronoConfig = {
  // Branding shown in print/PDF footers and exported guides
  branding: "Chrono Steps | Unfoundry",

  // Seconds before a step's timestamp when its visual cue begins fading in
  cueLeadSeconds: 2.5,

  // Seconds after a step's timestamp when its visual cue finishes fading out
  cueTrailSeconds: 2.5,

  // Enable smooth fade-in / fade-out opacity animation (1.0 at exact timestamp)
  cueFadeAnimation: true,

  // Minimum opacity floor while a cue is within its active window (0 = full fade to invisible)
  cueMinOpacity: 0,

  // Maximum video duration (seconds) allowed in local browser recovery cache (5 minutes)
  MAX_CACHED_VIDEO_DURATION: 300,

  // Maximum recording/video duration (seconds) before auto-stopping safely (15 minutes)
  MAX_VIDEO_DURATION: 900,
};
