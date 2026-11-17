// Public powder-alert channels on ntfy (https://ntfy.sh): three per resort, by size.
// Anyone can subscribe (that's the point: share them); the random prefix just keeps
// them from colliding with other people's channels. Used by the Alerts page (app.js)
// and the alert jobs (scripts/channel-alerts.cjs, scripts/weekend-alert.cjs).
const ALERT_TOPIC_PREFIX = 'snowfc-c3b361';
const ALERT_TIERS = [4, 8, 12]; // inches: biggest day in the next 3 (tomorrow counts snow by 9 am)
const alertTopic = (resortId, tier) => `${ALERT_TOPIC_PREFIX}-${resortId}-${tier}in`;
// Thursday weekend outlook (scripts/weekend-alert.cjs): one channel per region, keyed by
// the resort's state code lowercased, plus one for every region.
const WEEKEND_REGIONS = ['co', 'ut', 'ca', 'bc', 'all'];
const weekendTopic = (region) => `${ALERT_TOPIC_PREFIX}-weekend-${region}`;

if (typeof module !== 'undefined') module.exports = { ALERT_TOPIC_PREFIX, ALERT_TIERS, alertTopic, WEEKEND_REGIONS, weekendTopic };
