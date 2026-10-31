// Webcams per resort. Stills come from Brown Rice snapshot URLs (the host the
// resorts embed their cameras from); tapping one opens the live stream.
// To add a resort: find its camera ids on the resort's webcam page
// (player.brownrice.com/embed/<id>) and list them here.
const brownRice = (id, name) => ({
  name,
  img: `https://player.brownrice.com/snapshot/${id}`,
  live: `https://player.brownrice.com/embed/${id}`,
});

const CAMS = {
  purgatory: [
    brownRice('purgatorysnowstake1', 'Snow stake'),
    brownRice('purgatoryraysridge', "Ray's Ridge"),
    brownRice('purgatoryparadise', 'Paradise'),
    brownRice('purgatoryplaza', 'Plaza'),
  ],
  'wolf-creek': [
    brownRice('wolfcreeksummit', 'Summit'),
    brownRice('wolfcreektreasure', 'Treasure'),
    brownRice('wolfcreektresurlift', 'Treasure lift'),
  ],
};

if (typeof module !== 'undefined') module.exports = { CAMS };
