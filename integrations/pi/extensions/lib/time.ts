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
