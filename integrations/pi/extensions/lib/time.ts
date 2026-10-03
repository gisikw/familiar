// Shared time formatting for familiar extensions. Uses Intl with an explicit
// IANA zone (FAMILIAR_TZ, default America/Chicago).

const ZONE = process.env.FAMILIAR_TZ || "America/Chicago";

export const formatLocalTime = (date: Date = new Date()): string => {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return fmt.format(date);
};

export const humanizeDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 3600) return `about ${Math.floor(seconds / 60)} minutes`;
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.floor(seconds / 86400);
  return `about ${days} ${days === 1 ? "day" : "days"}`;
};

/** "Sat 3:41 PM": the stamp delivery wrappers carry (matches <familiar-restart at>). */
export const formatShortStamp = (date: Date): string =>
  date.toLocaleString("en-US", { timeZone: ZONE, weekday: "short", hour: "numeric", minute: "2-digit" });

/** Terse duration for attributes: "45s", "14m", "2h5m", "3d". */
export const compactDuration = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
};
