// Webcams per resort: up to four live pictures each, snow stake first. Tapping a picture
// opens the live stream (or the resort's webcam page when the host has no public player).
// Every picture URL here was checked to load and to be current on 2026-11-19. A picture that
// stops loading hides itself (see renderCams), so a dead camera just drops out.
//
// Hosts, and how to find a camera's id on a resort's webcam page:
// - Brown Rice: player.brownrice.com/embed/<id>
// - YouTube live: youtube.com/embed/<id> (camstreamer.com embeds wrap a YouTube video)
// - ipcamlive: player.php?alias=<alias>
// - HDRelay: manage.hdrelay.com/snapshot/<camera id>, or the watch.hdrelay.io poster for a cam_ id
// - Roundshot, Ozolio, Prism: ids from the embed or image URL
const brownRice = (id, name) => ({ name, img: `https://player.brownrice.com/snapshot/${id}`, live: `https://player.brownrice.com/embed/${id}` });
const youTube = (id, name) => ({ name, img: `https://i.ytimg.com/vi/${id}/sddefault_live.jpg`, live: `https://www.youtube.com/watch?v=${id}` });
const ipcam = (alias, name, host = 'g1') => ({ name, img: `https://${host}.ipcamlive.com/player/snapshot.php?alias=${alias}`, live: `https://${host}.ipcamlive.com/player/player.php?alias=${alias}` });
const hdRelay = (id, name) => ({ name, img: `https://manage.hdrelay.com/snapshot/${id}` });
const hdPoster = (cam, name) => ({ name, img: `https://watch.hdrelay.io/api/public/poster/${cam}` });
const roundshot = (id, name) => ({ name, img: `https://backend.roundshot.com/cams/${id}/medium` });
const ozolio = (oid, name) => ({ name, img: `https://relay.ozolio.com/pub.api?cmd=poster&oid=${oid}`, live: `https://relay.ozolio.com/pub.api?cmd=embed&oid=${oid}` });
const prism = (n, name) => ({ name, img: `https://storage.googleapis.com/prism-cam-${n}/360.jpg` });
const still = (img, name, live) => ({ name, img, live });

const CAMS = {
  'purgatory': [
    brownRice('purgatorysnowstake1', 'Snow stake'),
    brownRice('purgatoryraysridge', 'Ray\'s Ridge'),
    brownRice('purgatoryparadise', 'Paradise'),
    brownRice('purgatoryplaza', 'Plaza'),
  ],
  'wolf-creek': [
    brownRice('wolfcreeksummit', 'Summit'),
    brownRice('wolfcreektreasure', 'Treasure'),
    brownRice('wolfcreektresurlift', 'Treasure lift'),
  ],
  'telluride': [
    ipcam('powcam', 'Pow cam'),
    ipcam('bonvivant', 'Black Iron Bowl'),
    ipcam('jointpoint', 'See Forever'),
    ipcam('plazacam', 'Village'),
  ],
  'crested-butte': [
    brownRice('Crestedbuttebase', 'Base'),
    brownRice('Crestedbuttebar', 'Ten Peaks'),
    brownRice('Crestedbuttewarm', 'Paradise'),
  ],
  'arapahoe-basin': [
    hdPoster('cam_arapahoe_basin_snow_stake_camera_1790623452872', 'Snow stake'),
    hdPoster('cam_arapahoe_basin_pali_cam_1790623627806', 'Pali'),
    hdPoster('cam_arapahoe_basin_black_mountain_lodge_1790623952319', 'Black Mountain Lodge'),
    hdPoster('cam_arapahoe_basin_patrol_headquarters_1790624063379', 'Patrol HQ'),
  ],
  'breckenridge': [
    still('https://cache.snow.com/Mtncams/BreckSnowStake.jpg', 'Snow stake'),
    brownRice('breckenridge10', 'Peak 9'),
    brownRice('breckenridge9', 'Peak 8'),
    brownRice('breckenridge7', 'Peak 7'),
  ],
  'copper-mountain': [
    still('https://img.hdrelay.com/frames/fb469125-f1f3-459f-aeb4-98cb674e395f/default/last.jpg', 'Snow stake'),
    hdPoster('cam_copper_mountain___union_1790871057199', 'Union Peak'),
    hdPoster('cam_copper_mountain___excelerator_1791911614707', 'Excelerator'),
    hdPoster('cam_copper_mountain___center_village_1791904709663', 'Center Village'),
  ],
  'keystone': [
    still('https://cache.snow.com/Mtncams/KeySnowStake.jpg', 'Snow stake'),
    brownRice('keystonenorthpeak', 'North Peak'),
    brownRice('keystonedercum', 'Dercum Mountain'),
    brownRice('keystoneriverrun', 'River Run'),
  ],
  'loveland-basin': [
    still('https://cams.skiloveland.com/snowcam/snowcam.jpg', 'Snow stake'),
  ],
  'winter-park': [
    youTube('yj-5Q1vBMaA', 'Snow stake'),
    youTube('HfX4H3MSwXs', 'Lunch Rock'),
    still('https://cams.winterparkresort.com/best-western-cam.jpg', 'Base'),
    youTube('Dt_WhmxV0yE', 'Snoasis'),
  ],
  'eldora': [
    hdPoster('cam_eldora___snow_stake_1792456287972', 'Snow stake'),
    hdPoster('cam_eldora___alpenglow_1792456287847', 'Alpenglow'),
  ],
  'granby-ranch': [
    brownRice('granby2', 'Granby Ranch'),
  ],
  'vail': [
    brownRice('vailsnowsummit', 'Snow stake'),
    brownRice('vaileaglesnest', 'Eagle\'s Nest'),
    brownRice('vailch21', 'Back Bowls'),
    brownRice('vailch11', 'Sun Up Bowl'),
  ],
  'beaver-creek': [
    brownRice('bcsnowstake2', 'Snow stake'),
    brownRice('bcspruce', 'Spruce'),
    brownRice('bcredbuffalo', 'Red Buffalo'),
    brownRice('bcmccoy', 'McCoy Park'),
  ],
  'aspen-mountain': [
    roundshot('91', 'Aspen Mountain'),
  ],
  'aspen-highlands': [
    roundshot('89', 'Aspen Highlands'),
  ],
  'buttermilk': [
    roundshot('87', 'Buttermilk'),
  ],
  'snowmass': [
    roundshot('88', 'Snowmass'),
  ],
  'monarch-mountain': [
    brownRice('skimonarchpanoflats', 'Panorama Flats'),
    brownRice('skimonarchsundeck', 'Sundeck'),
  ],
  'powderhorn': [
    still('https://b16.hdrelay.com/camera/6376ac116db11e6bbdca2564/snapshot', 'Powderhorn'),
  ],
  'sunlight': [
    ipcam('sunlightsnowstake', 'Snow stake'),
    ipcam('compasspeak', 'Compass Peak', 'g0'),
    ipcam('sopris', 'Mt. Sopris', 'g0'),
  ],
  'alta': [
    still('https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/Collins_Snow_Stake.jpg', 'Snow stake'),
    still('https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/Superior.jpg', 'Mt. Superior'),
    still('https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/Highrustler.jpg', 'High Rustler'),
    still('https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/sugar_peak.jpg', 'Sugarloaf'),
  ],
  'snowbird': [
    hdRelay('8611e276-7ee5-42c0-b8cd-d9e1890e1cd4', 'Snow stake'),
    hdRelay('544432bd-3910-4888-aa9f-14b6f51a7eb5', 'Peruvian Gulch'),
    hdRelay('5780754f-8da1-4223-ab8a-6755d84cbc10', 'Mineral Basin'),
    roundshot('44cfff4ff2a218a1178dbb105d95846a', 'Hidden Peak'),
  ],
  'brighton': [
    youTube('Zv8HYwaXjBg', 'Top of Crest 6'),
    youTube('4a-3iEM7bHk', 'Parking lot'),
  ],
  'solitude': [
    youTube('lkEM6EC8NVA', 'Snow stake'),
    youTube('ta-4QZbfMXc', 'Honeycomb Canyon'),
    youTube('xNER0JHrqLg', 'Powderhorn'),
    youTube('Lnznapxh2xM', 'Sunshine Bowl'),
  ],
  'park-city': [
    brownRice('parkcitytopcrescent', 'Top of Crescent'),
    brownRice('parkcitylookoutcabin', 'Lookout Cabin'),
    brownRice('parkcityhighmeadow', 'High Meadow'),
    brownRice('parkcitymtnvillage', 'Mountain Village'),
  ],
  'deer-valley': [
    youTube('r8qiPv9XCOM', 'Empire Express'),
    youTube('XZjubaPbamE', 'Revelator Express'),
  ],
  'snowbasin': [
    prism('00054', 'Snowbasin'),
    prism('00115', 'John Paul'),
  ],
  'powder-mountain': [
    prism('00107', 'Snow stake'),
    prism('00109', 'Lightning Ridge'),
    prism('00112', 'Hidden Lake'),
    prism('00113', 'Timberline base'),
  ],
  'beaver-mountain': [
    ipcam('beaversnowdepthboard', 'Snow depth board'),
    ipcam('lodgedreamliftcam', 'Lodge & Dreamlift'),
    ipcam('littlebeavercam', 'Little Beaver'),
  ],
  'brian-head': [
    hdRelay('66e069aee2c05fceb65b6688', 'Snow stake'),
    hdRelay('6eb6815f-7f56-40cf-b38f-4ec985956b43', 'Navajo base'),
    hdRelay('bcca39a1-43c0-477f-9389-5b039c797c5d', 'Giant Steps base'),
    hdRelay('1fbebe18-f211-4fec-a185-0024cbc0838c', 'Giant Steps summit'),
  ],
  'nordic-valley': [
    youTube('a_75PFulDyg', 'Nordic Valley'),
  ],
  'sundance': [
    hdPoster('cam_sundance_mountain___mandan_summit_1781718266360', 'Mandan summit'),
  ],
  'cherry-peak': [
    still('https://www.ixnay.net/cams/cp/summit/current.jpg', 'Summit', 'https://www.ixnay.net/cams/cherrypeak/index.php'),
  ],
  'palisades-tahoe-olympic-valley': [
    ozolio('EMB_EIFC0000015B', 'Scope 8,200\''),
    ozolio('EMB_OBCE00000ECB', 'Siberia'),
    ozolio('EMB_ZIGI00000147', 'Base 6,200\''),
    ozolio('EMB_EMST000001C4', 'Far East'),
  ],
  'palisades-tahoe-alpine-meadows': [
    ozolio('EMB_VPAY0000014C', 'Alpine peak'),
    ozolio('EMB_KIYV000003C2', 'Alpine race'),
    ozolio('EMB_FPOI000010AB', 'Alpine chalet'),
  ],
  'heavenly': [
    brownRice('heavenlytram', 'Top of Tram'),
    brownRice('heavenlyeastpeak', 'East Peak'),
    brownRice('heavenlymidstation', 'Gondola midstation'),
  ],
  'northstar': [
    brownRice('northstarsnowstake', 'Snow stake'),
    brownRice('northstarspluto', 'Mt. Pluto summit'),
    brownRice('northstarmidmountain', 'Mid-mountain'),
    brownRice('northstarvillage', 'Village'),
  ],
  'kirkwood': [
    brownRice('kirkwoodcornice', 'Cornice'),
    brownRice('kirkwoodredcliffs', 'Red Cliffs'),
  ],
  'sierra-at-tahoe': [
    still('https://img.hdrelay.com/frames/f5145304-44dc-475f-a654-8a7bacee1e81/sugar/last.jpg', 'Sierra-at-Tahoe'),
  ],
  'donner-ski-ranch': [
    youTube('ArDIIhAHwWE', 'Deck'),
  ],
  'mammoth-mountain': [
    youTube('m4u2kGpkYD4', 'Main Lodge'),
  ],
  'june-mountain': [
    youTube('itJI-3uiYkI', 'Chalet'),
    youTube('-8keQPZV3rw', 'Chair J3'),
    youTube('-U--7tKsSQU', 'Patrol'),
  ],
  'bear-valley': [
    youTube('gB2fWpBXbBw', 'Base'),
    youTube('IjopOQByGiY', 'Summit'),
  ],
  'dodge-ridge': [
    youTube('RjXOWYVMqA0', 'Summit'),
    youTube('DMVtrxOK-JM', 'Waystation'),
    youTube('cuMEPeePwjY', 'Base'),
  ],
  'china-peak': [
    youTube('QDGBc2xzH1w', 'Summit'),
    youTube('Tu2d8gii-tE', 'Mid-mountain'),
    youTube('XY57S1_Dpb0', 'Top of Chair 7'),
    youTube('uGABP9cNvMk', 'Base'),
  ],
  'mt-shasta': [
    still('https://img.hdrelay.com/frames/cb74351c-d928-4ba1-b001-fab4592e7a69/default/last.jpg', 'Mt. Shasta'),
  ],
  'bear-mountain': [
    youTube('WmCvQQ2eZxg', 'Bear Peak'),
    youTube('Y5CWe7XUszQ', 'Midway (Chair 5)'),
    youTube('f_OUEF4csuo', 'Base'),
  ],
  'snow-summit': [
    youTube('JWoGxvDfgIA', 'Miracle Mile'),
    youTube('SOo3NBmvJQI', 'Slopeside'),
    youTube('Kn4IAs67hNo', 'Beginner area'),
  ],
  'snow-valley': [
    youTube('1GyTQP4SNDk', 'Peak'),
    youTube('qPqufIWZAd4', 'Slide Peak'),
    youTube('RBYyWnu8nhM', 'Base'),
  ],
  'mountain-high': [
    youTube('Ff7bdARKbp8', 'East summit'),
    youTube('HrcwV3xu_MQ', 'Upper Chisholm'),
    youTube('v3xNz0aKNSA', 'West base'),
    youTube('u-_G1XChHrU', 'North lodge'),
  ],
  'mt-baldy': [
    youTube('2PM5YvPygiQ', 'Top of Chair 1'),
  ],
  'whistler': [
    brownRice('whistlerpeak', 'Whistler Peak'),
    brownRice('whistlerroundhouse', 'Roundhouse'),
    brownRice('whistler7thheaven', '7th Heaven'),
    brownRice('whistlervillage', 'Village'),
  ],
};

// Official webcam page per resort, shown as a link under the pictures. Left out for resorts with
// no webcam page of their own (Silverton, Soda Springs, Cherry Peak) and for Mount Waterman,
// whose old web address now belongs to someone else.
const CAM_PAGES = {
  'purgatory': 'https://www.purgatory.ski/mountain/weather-conditions-webcams/webcams/',
  'wolf-creek': 'https://wolfcreekski.com/webcams/',
  'telluride': 'https://tellurideskiresort.com/webcams/',
  'crested-butte': 'https://www.skicb.com/the-mountain/mountain-conditions/mountain-cams',
  'arapahoe-basin': 'https://www.arapahoebasin.com/mountain-cams/',
  'breckenridge': 'https://www.breckenridge.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'copper-mountain': 'https://www.coppercolorado.com/the-mountain/webcams/',
  'keystone': 'https://www.keystoneresort.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'loveland-basin': 'https://skiloveland.com/webcams/',
  'winter-park': 'https://www.winterparkresort.com/the-mountain/mountain-cams',
  'eldora': 'https://www.eldora.com/the-mountain/current-conditions/webcams/',
  'echo-mountain': 'https://echomtn.com/mountain-conditions',
  'granby-ranch': 'https://granbyranch.com/granby-ranch-webcam/',
  'vail': 'https://www.vail.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'beaver-creek': 'https://www.beavercreek.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'aspen-mountain': 'https://www.aspensnowmass.com/our-mountains/aspen-mountain/mountain-cams',
  'aspen-highlands': 'https://www.aspensnowmass.com/our-mountains/aspen-highlands/mountain-cams',
  'buttermilk': 'https://www.aspensnowmass.com/our-mountains/buttermilk/mountain-cams',
  'snowmass': 'https://www.aspensnowmass.com/our-mountains/snowmass/mountain-cams',
  'steamboat': 'https://www.steamboat.com/the-mountain/live-cams',
  'monarch-mountain': 'https://skimonarch.com/conditions/cams/',
  'powderhorn': 'https://www.powderhorn.com/explore/conditions/webcams.html',
  'ski-cooper': 'https://skicooper.com/weather-webcams',
  'sunlight': 'https://sunlightmtn.com/explore/mountain-status/',
  'hesperus': 'https://www.ski-hesperus.com/mountain-cam/',
  'alta': 'https://www.alta.com/weather#mountain-cams',
  'snowbird': 'https://www.snowbird.com/the-mountain/webcams/view-all-webcams/',
  'brighton': 'https://www.brightonresort.com/conditions',
  'solitude': 'https://www.solitudemountain.com/mountain-and-village/webcams',
  'park-city': 'https://www.parkcitymountain.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'deer-valley': 'https://www.deervalley.com/explore-the-mountain/webcams',
  'snowbasin': 'https://www.snowbasin.com/the-mountain/web-cams',
  'powder-mountain': 'https://powdermountain.com/conditions',
  'beaver-mountain': 'https://www.skithebeav.com/mountain/conditions/',
  'brian-head': 'https://www.brianhead.com/weather-conditions-webcams/webcams/',
  'nordic-valley': 'https://www.nordicvalley.ski/nordic-valley-weather-conditions-webcams/',
  'sundance': 'https://www.sundanceresort.com/webcams/',
  'eagle-point': 'https://www.eaglepointresort.com/mountain-conditions/',
  'palisades-tahoe-olympic-valley': 'https://www.palisadestahoe.com/mountain-information/webcams',
  'palisades-tahoe-alpine-meadows': 'https://www.palisadestahoe.com/mountain-information/webcams',
  'heavenly': 'https://www.skiheavenly.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'northstar': 'https://www.northstarcalifornia.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'kirkwood': 'https://www.kirkwood.com/the-mountain/mountain-conditions/mountain-cams.aspx',
  'sugar-bowl': 'https://www.sugarbowl.com/webcams',
  'boreal': 'https://www.rideboreal.com/explore/webcams/',
  'sierra-at-tahoe': 'https://sierraattahoe.com/live-cams/',
  'homewood': 'https://skihomewood.com/webcams',
  'donner-ski-ranch': 'https://www.donnerskiranch.com/webcams',
  'mammoth-mountain': 'https://www.mammothmountain.com/on-the-mountain/mammoth-webcam',
  'june-mountain': 'https://www.junemountain.com/mountain-information/live-cams',
  'bear-valley': 'https://www.bearvalley.com/webcam',
  'dodge-ridge': 'https://dodgeridge.com/webcams',
  'china-peak': 'https://www.skichinapeak.com/webcam/',
  'badger-pass': 'https://www.yosemite.com/yosemite-webcams/badger-pass-ski-area-webcam/',
  'mt-shasta': 'https://www.skipark.com/winter/mountain-cams',
  'bear-mountain': 'https://bigbearmountainresort.com/webcams/bear-mountain',
  'snow-summit': 'https://www.bigbearmountainresort.com/cams/summit-base',
  'snow-valley': 'https://www.bigbearmountainresort.com/webcams/snow-valley',
  'mountain-high': 'https://www.mthigh.com/site/cams',
  'mt-baldy': 'https://mtbaldyresort.com/web-cam',
  'whistler': 'https://www.whistler.com/webcam',
};

if (typeof module !== 'undefined') module.exports = { CAMS, CAM_PAGES };
