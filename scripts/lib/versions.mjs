// Pick the newest stable release that is at least `minAgeDays` old (a new release can carry malware before anyone notices).
const parse = (v) => v.split(/[.+-]|(?<=\d)(?=[abrc])/).slice(0, 5).map((x) => parseInt(x, 10) || 0);
export function cmpVersion(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 4; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
  return 0;
}
const isStable = (v) => /^\d+(\.\d+){0,3}$/.test(v);
// Some packages (e.g. opentelemetry-distro) only ever publish beta-tagged releases: allow a/b/rc, never dev.
const isStableOrBeta = (v) => /^\d+(\.\d+){0,3}((a|b|rc)\d+)?$/.test(v);

// times: { "1.2.3": "2026-01-01T00:00:00Z", ... }
export function pickVersion(times, nowMs, minAgeDays = 14, allowPre = false) {
  const cutoff = nowMs - minAgeDays * 86400000;
  const ok = Object.entries(times)
    .filter(([v, t]) => (allowPre ? isStableOrBeta(v) : isStable(v)) && Date.parse(t) <= cutoff)
    .map(([v]) => v)
    .sort(cmpVersion);
  return ok.length ? ok[ok.length - 1] : null;
}
