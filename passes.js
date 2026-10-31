// Which multi-resort passes include each resort (2025–26 season, from memory of
// the pass lineups; double-check epicpass.com, ikonpass.com and indyskipass.com,
// since lineups change every year and some partners have blackout or day limits).
// Resorts not listed have none of these passes (Purgatory sells its own Power Pass).
const PASSES = {
  epic: {
    name: 'Epic',
    resorts: ['vail', 'beaver-creek', 'breckenridge', 'keystone', 'crested-butte', 'telluride', 'park-city', 'heavenly', 'northstar', 'kirkwood'],
  },
  ikon: {
    name: 'Ikon',
    resorts: [
      'winter-park', 'copper-mountain', 'steamboat', 'eldora', 'arapahoe-basin', 'aspen-mountain', 'aspen-highlands', 'buttermilk', 'snowmass',
      'alta', 'snowbird', 'brighton', 'solitude', 'deer-valley', 'snowbasin',
      'palisades-tahoe-olympic-valley', 'palisades-tahoe-alpine-meadows', 'mammoth-mountain', 'june-mountain', 'bear-mountain', 'snow-summit',
    ],
  },
  indy: {
    name: 'Indy',
    resorts: ['powderhorn', 'sunlight', 'eagle-point', 'beaver-mountain', 'cherry-peak', 'nordic-valley', 'china-peak', 'mt-shasta'],
  },
};

const passesFor = (id) => Object.entries(PASSES).filter(([, p]) => p.resorts.includes(id)).map(([k]) => k);

if (typeof module !== 'undefined') module.exports = { PASSES, passesFor };
