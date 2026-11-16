// Public powder-alert channels on ntfy (https://ntfy.sh): three per resort, by size.
// Anyone can subscribe (that's the point: share them); the random prefix just keeps
// them from colliding with other people's channels. Used by the Alerts page (app.js)
// and the evening alert job (scripts/alerts.cjs).
const ALERT_TOPIC_PREFIX = 'snowfc-c3b361';
const ALERT_TIERS = [4, 8, 12]; // inches: biggest day in the next 3 (tomorrow counts snow by 9 am)
const alertTopic = (resortId, tier) => `${ALERT_TOPIC_PREFIX}-${resortId}-${tier}in`;

if (typeof module !== 'undefined') module.exports = { ALERT_TOPIC_PREFIX, ALERT_TIERS, alertTopic };
