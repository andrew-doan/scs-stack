// The SCS.2 Legends of the City quest list, as imported into the tab
// database by the console's "Import the SCS.2 list" action. Each entry
// is one quest group: the lead code plus any tier or bonus codes, the
// text the site shows, the map pins, and the kind of answer box the
// submit page adds. Once imported the database is the source of truth
// and this file is only the starting point.
//
// submit: none (photos and videos only), count (a number), text (a
// short answer), pick (choose from a list: options, or @stations /
// @sushi for the built-in lists), codes (tick which of the group's
// codes were done). A code may say how it scores (src/parts.js:
// scoring, most, bands), and a quest whose challenge is counted carries
// its rules.

import type { Band, Scoring, TallyKind } from '../types.ts';

// One quest of the list, as importScs2 (quests.ts) reads it.
export interface SeedQuest {
  key: string;
  region: string;
  name: string;
  description: string;
  flavour: string;
  location: string;
  coords: { label: string; lat: number; lng: number }[];
  submit: string;
  prompt: string;
  options: string[];
  codes: { code: string; label: string; points: number; scoring?: Scoring; most?: number; bands?: Band[] }[];
  rules?: { tally: { kind: TallyKind; awards: number[] } };
}

export var REGIONS = [
  'The Mainland', 'Clubs Region', 'Briefings Region', 'Competition Region',
  'Transportation Region', 'Exploration Region', 'Cultural Region',
  'Macquarie Region', 'Unashamed Region', 'Physical Region', 'Region 11'
];

function q(key: string, region: string, name: string, points: number, extra?: Partial<SeedQuest>): SeedQuest {
  var g: SeedQuest = {
    key: key, region: region, name: name,
    description: '', flavour: '', location: '', coords: [],
    submit: 'none', prompt: '', options: [],
    codes: [{ code: key, label: '', points: points }]
  };
  return Object.assign(g, extra);
}

export var QUESTS: SeedQuest[] = [
  // ---- The Mainland ----
  q('MQ1', 'The Mainland', 'Parramatta', 400, {
    description: 'Visit the SCS.2 Parramatta Hub and complete the required tasks.',
    location: 'UNSW Parramatta Campus, 6 Hassall St, Parramatta (Level 5)',
    coords: [{ label: 'UNSW Parramatta', lat: -33.8178, lng: 151.00754 }]
  }),
  q('MQ2', 'The Mainland', 'Epping (TBD)', 400, {
    description: 'Visit the SCS.2 Epping Hub and complete the required tasks.',
    location: 'Forest Park, Forest Grove, Epping',
    coords: [{ label: 'Forest Park, Epping', lat: -33.7752, lng: 151.0849 }]
  }),
  q('MQ3', 'The Mainland', 'Flemington (TBD)', 400, {
    description: 'Visit the SCS.2 Flemington Hub and complete the required tasks.',
    location: 'Flemington'
  }),
  q('MQ4', 'The Mainland', 'UNSW', 400, {
    description: 'Visit the SCS.2 UNSW Hub and complete the required tasks.',
    location: 'UNSW Kensington',
    coords: [{ label: 'UNSW Kensington', lat: -33.9173, lng: 151.2313 }]
  }),
  q('MrSCS', 'The Mainland', 'Mr Sydney Challenge Scramble', 800, {
    description: 'Visit all the Hubs and complete all required tasks.'
  }),
  q('MsSCS', 'The Mainland', 'Ms Sydney Challenge Scramble', 400, {
    description: 'Complete the most amount of unique challenges out of all the teams.\n\n**Partial completion awarded for:** runner up.',
    codes: [{ code: 'MsSCS', label: 'Most unique challenges', points: 400 }, { code: 'MsSCS-R', label: 'Runner up', points: 200 }]
  }),

  // ---- Clubs Region ----
  q('CQ1', 'Clubs Region', 'Asian Studies Association', 1, { description: 'tbd' }),
  q('CQ2', 'Clubs Region', 'Chess Club', 1, { description: 'tbd' }),
  q('CQ3', 'Clubs Region', 'GeoGuessrSoc', 1, { description: 'tbd' }),
  q('CQ4', 'Clubs Region', 'PhotoSoc', 1, { description: 'tbd' }),
  q('CQ5', 'Clubs Region', 'PuzzleSoc', 1, { description: 'tbd' }),
  q('CQ6', 'Clubs Region', 'Queer Students in STEM', 1, { description: 'tbd' }),
  q('CQ7', 'Clubs Region', 'Rhythm Games Society', 1, { description: 'tbd' }),
  q('CQ8', 'Clubs Region', 'Tabletop Games Galore', 1, {
    description: 'Take a photo of each of the following boardgames (any edition of these games are also acceptable). Each must be taken in a unique boardgame store location.\n\n- Flip 7\n- Catan\n- Spirit Island\n- Compile\n- Harmonies\n\nEach submission should include a photo of one of the games and a photo of one teammate outside of the unique boardgame store.',
    submit: 'pick', prompt: 'Which game is this submission for?',
    options: ['Flip 7', 'Catan', 'Spirit Island', 'Compile', 'Harmonies']
  }),
  q('CQ9', 'Clubs Region', 'WanderSoc', 1, { description: 'tbd' }),
  q('CQ10', 'Clubs Region', 'WestSoc', 1, { description: 'tbd' }),
  q('Arc', 'Clubs Region', 'Arc Clubs No.1 Fan', 1, {
    description: 'Complete all the Society Quests.\n\n**Partial completion awarded for:** 5, 6, 7, 8 or 9 Society Quests.',
    submit: 'count', prompt: 'How many Society Quests did you complete?',
    codes: [
      { code: 'Arc', label: 'Society Quests done', points: 1, scoring: 'tiered',
        bands: [{ from: 5, points: 1 }, { from: 6, points: 1 }, { from: 7, points: 1 }, { from: 8, points: 1 }, { from: 9, points: 1 }, { from: 10, points: 1 }] }
    ]
  }),

  // ---- Briefings Region ----
  q('BQ1', 'Briefings Region', 'On Time!', 200, {
    description: 'Have your whole team show up, on time, before 10:00 am sharp, for the Briefings.',
    flavour: 'Sydney Trains apologises for any delay. You may not.'
  }),
  q('BQ2', 'Briefings Region', 'The Sydney CosCon', 200, {
    description: 'Have your whole team dressed in cosplay or a coordinated team costume at the start of the competition.\n\n**Notes:** For the purposes of this quest, if an average ordinary person can tell you are dressed up and guess the theme you are dressed up as, this will be enough to count as completed for this quest.',
    flavour: 'The 12:04 Penrith is NOT ready for what we are about to wear.'
  }),
  q('BQ3', 'Briefings Region', 'I Never Mentally Grew Up', 67, {
    description: 'Find Jimmy Wu and perform your best “67” re-enactment to him.\n\n**Notes:** He is the RailSoc President, you might find a photo of him somewhere…',
    flavour: 'He knows why you’re approaching him. And he has made peace with it.'
  }),
  q('BQ4', 'Briefings Region', 'Higher Priorities', 200, {
    description: 'Record your whole attempt on Strava or any other GPS tracking app and then send the GPX file to OrgComm for a cool graphic…',
    flavour: 'Marketing’s Orders!'
  }),

  // ---- Competition Region ----
  q('SQ1', 'Competition Region', 'RailSoc Award for Most Amount of Stations Visited', 300, {
    description: 'Visit as many stations (Light Rail, Train or Metro) as possible.\n\n**Bonus:** Using only the first letters of the stations you visited, spell the longest real English word you can. You cannot use a letter multiple times in the word, but you can visit multiple stations starting with the same letter to let you use that letter more than once.\n\n**Notes:** At least one person on your team must get off at each station. Photos must be taken on the platform with the station sign visible.\n\n**Partial completion awarded for:** 10–14, 15–19, 20–24 or 25+ stations. Tiers are not cumulative; a team receives the highest tier reached.',
    flavour: 'If you are wondering what the possible longest word using Sydney stations is, its ELECTROENCEPHALOGRAPHICALLY.',
    submit: 'pick', prompt: 'Which station is this submission for?', options: ['@stations'],
    rules: { tally: { kind: 'picks', awards: [300] } },
    codes: [
      { code: 'SQ1', label: 'Stations', points: 0, scoring: 'counted',
        bands: [{ from: 10, points: 100 }, { from: 15, points: 175 }, { from: 20, points: 275 }, { from: 25, points: 400 }] },
      { code: 'SQ1-B', label: 'Longest word bonus', points: 100 }
    ]
  }),
  q('SQ2', 'Competition Region', 'I Want to Go to Japan Again', 100, {
    description: 'Visit as many Sushi Hubs as possible. Take a team photo outside each with signage visible.\n\n**Notes:** Submit the photo and the location of the Sushi Hub.\n\n**Partial completion awarded for:** 3, 5 or 7+ Sushi Hubs. Highest tier reached only.',
    flavour: 'You should do that Japan trip you have been wanting to do.',
    submit: 'pick', prompt: 'Which Sushi Hub is this?', options: ['@sushi'],
    rules: { tally: { kind: 'picks', awards: [100] } },
    codes: [
      { code: 'SQ2', label: 'Sushi Hubs', points: 0, scoring: 'counted',
        bands: [{ from: 3, points: 50 }, { from: 5, points: 100 }, { from: 7, points: 175 }] }
    ]
  }),
  q('SQ3', 'Competition Region', 'We Are Very Cool', 150, {
    description: 'Take the coolest group photo.\n\n**Notes:** You may take it in conjunction with another team and both be credited.\n\n**Partial completion awarded for:** runner up.',
    codes: [{ code: 'SQ3', label: 'Coolest photo', points: 150 }, { code: 'SQ3-R', label: 'Runner up', points: 75 }]
  }),
  q('SQ4', 'Competition Region', 'Bin Chicken Photography Challenge', 100, {
    description: 'The team who captures the highest number of bin chickens (Australian white ibis) in a single photo wins.',
    flavour: 'Majestic, prehistoric, and currently in a bin.',
    submit: 'count', prompt: 'How many bin chickens are in the photo?',
    rules: { tally: { kind: 'highest', awards: [100] } },
    codes: [{ code: 'SQ4', label: 'Bin chickens in one photo', points: 0, scoring: 'counted' }]
  }),
  q('SQ5', 'Competition Region', 'Bye Sydney!', 300, {
    description: 'Take a screenshot of a mapping service showing the location of your team. The team that has the furthest location from Central by the end of the event wins!',
    flavour: 'Sometimes the best thing to do in Sydney is to actually leave.',
    location: 'As far from Central as you dare',
    submit: 'text', prompt: 'Where were you?'
  }),

  // ---- Transportation Region ----
  q('SQ6', 'Transportation Region', 'The Full Modal', 150, {
    description: 'Photograph your team on all five public transport modes in one day: Sydney Trains, Metro, Light Rail, Bus and Ferry.',
    flavour: 'Sydney PT final boss.'
  }),
  q('SQ7', 'Transportation Region', 'Level Crossing Hunter', 450, {
    description: 'Sydney’s suburban network has almost no road level crossings left. Photograph your team at one.',
    location: 'Richmond Line, Leppington Line'
  }),
  q('SQ8', 'Transportation Region', 'Shot My Shot at Haunted Central!', 50, {
    description: 'A two-part task. Take the (famously creepy) stairs down to Platforms 24 and 25 at Central. Take a photo of a teammate pretending to be shot next to the bullet hole near Platform 1.',
    location: 'Central Station, Platforms 1 and 24–25',
    coords: [{ label: 'Central Station', lat: -33.8832, lng: 151.2070 }]
  }),
  q('SQ9', 'Transportation Region', 'Ride a Diesel Train', 200, {
    description: 'Send a picture of your team relaxing on board a diesel train.',
    flavour: 'Electrification is for the weak.'
  }),
  q('SQ10', 'Transportation Region', 'MaccasLand', 50, {
    description: 'Eat some Macca’s at Macdonaldtown Station.',
    location: 'Macdonaldtown Station',
    coords: [{ label: 'Macdonaldtown Station', lat: -33.8967, lng: 151.1866 }]
  }),
  q('SQ11', 'Transportation Region', 'Who The Fuck Stops Here?', 25, {
    description: 'Take a group photo at Clyde Station.',
    location: 'Clyde Station',
    coords: [{ label: 'Clyde Station', lat: -33.8343, lng: 151.0173 }]
  }),
  q('SQ12', 'Transportation Region', 'Law Abiding Citizen', 25, {
    description: 'Get your tickets checked by transport officers (“ticketos”). Hope you tapped on! You may complete this challenge as many times as possible with different ticketos. Capped at 200 points.',
    flavour: 'For once in your life, you WANT to see them coming.',
    submit: 'count', prompt: 'How many times have your tickets been checked?',
    codes: [{ code: 'SQ12', label: 'Per check, capped at 200', points: 25, scoring: 'unit', most: 8 }]
  }),
  q('SQ13', 'Transportation Region', 'Strung Up!', 150, {
    description: 'Traverse an entire train (Metro or Sydney Trains) end to end with your shoelaces tied to another teammate’s.\n\n**Notes:** Some trains (Tangaras and Millenniums) have a divide in the middle which will make this challenge harder. Be careful and be mindful of the public.'
  }),

  // ---- Exploration Region ----
  q('SQ14', 'Exploration Region', 'Ashing at Ashfield', 25, {
    description: 'Do your best impression of smoking a cigar at Ashfield Station.',
    location: 'Ashfield Station',
    coords: [{ label: 'Ashfield Station', lat: -33.8880, lng: 151.1257 }]
  }),
  q('SQ15', 'Exploration Region', 'Is the Escalator Working?', 25, {
    description: 'Take a photo of your group at any of the escalators at Ashfield Mall.',
    location: 'Ashfield Mall, Ashfield',
    coords: [{ label: 'Ashfield Mall', lat: -33.8890, lng: 151.1250 }]
  }),
  q('SQ16', 'Exploration Region', 'Nominative Determinism', 25, {
    description: 'Photograph the whole team looking as bored as humanly possible on Bland Street.',
    location: 'Bland St, Ashfield',
    coords: [{ label: 'Bland St, Ashfield', lat: -33.8880, lng: 151.1290 }]
  }),
  q('SQ17', 'Exploration Region', 'One O’Clock', 75, {
    description: 'Be at Observatory Hill at 1:00 pm and film the time ball dropping on the Sydney Observatory tower. Be on time, it will not wait for you!',
    location: 'Sydney Observatory, Millers Point',
    coords: [{ label: 'Sydney Observatory', lat: -33.8595, lng: 151.2044 }]
  }),
  q('SQ18', 'Exploration Region', 'The Snout', 25, {
    description: 'On Macquarie St outside Sydney Hospital sits a bronze boar (Il Porcellino). Photograph your team rubbing his snout for luck.',
    flavour: 'Polished to a shine by a century of superstition and exam-season desperation.',
    location: 'Sydney Hospital, Macquarie St, Sydney',
    coords: [{ label: 'Il Porcellino, Sydney Hospital', lat: -33.8678, lng: 151.2126 }]
  }),
  q('SQ19', 'Exploration Region', 'A Monstrosity for the Ages', 50, {
    description: '*Tall, grey, and hard to miss. Some call me iconic… others dismiss. My lifts test patience, my floors confuse, you’ll get lost here with no excuse.*\n\nPhotograph your team with it.',
    flavour: 'Brutalism’s greatest hit.',
    location: '???'
  }),
  q('SQ20', 'Exploration Region', 'Blocking the Suez Canal!', 50, {
    description: 'Want to recreate the Suez Canal being blocked by a container ship, right here in Sydney? It’s your lucky day, the Suez Canal is Sydney’s narrowest street! It’s a historic alley running between George and Harrington Streets in The Rocks. Take a photo of your group fully blocking the street from side to side. Be quick so you don’t inconvenience the public!',
    location: 'Suez Canal laneway, The Rocks',
    coords: [{ label: 'Suez Canal, The Rocks', lat: -33.8593, lng: 151.2081 }]
  }),
  q('SQ21', 'Exploration Region', 'Hyperconsumerism', 25, {
    description: 'Pose with the large shopfront Labubu in the Pavilion Plaza tunnel (Exit 3).',
    flavour: 'It’s watching you. It’s always been watching you.',
    location: 'Town Hall Station, Pavilion Plaza tunnel (Exit 3)',
    coords: [{ label: 'Town Hall Station, Exit 3', lat: -33.8734, lng: 151.2069 }]
  }),
  q('SQ22', 'Exploration Region', 'What a View!', 25, {
    description: 'Make a short video of your group admiring the view from Circular Quay Station, Platform 2.',
    location: 'Circular Quay Station',
    coords: [{ label: 'Circular Quay Station', lat: -33.8613, lng: 151.2107 }]
  }),
  q('SQ23', 'Exploration Region', 'Gambler’s Dream', 50, {
    description: 'Visit the outside of both The Star and Crown casino and enact your best "make it rain" impression. You do not have to go inside.',
    location: 'The Star Casino; Crown Sydney',
    coords: [{ label: 'The Star', lat: -33.8677, lng: 151.1950 }, { label: 'Crown Sydney', lat: -33.8614, lng: 151.2010 }]
  }),
  q('SQ24', 'Exploration Region', 'Fish Out Of Water', 75, {
    description: 'Buy something at the new Sydney Fish Market at Blackwattle Bay and photograph your team holding it underneath the roof.',
    location: 'Sydney Fish Market, Blackwattle Bay, Pyrmont',
    coords: [{ label: 'Sydney Fish Market', lat: -33.8720, lng: 151.1900 }]
  }),
  q('SQ25', 'Exploration Region', 'I Have a Dream', 75, {
    description: '*Words of hope upon a wall, echoing a leader’s call. In Newtown I stand for all to see, a dream of change and unity.*\n\nFind it and photograph your team with it.',
    location: 'King St, Newtown',
    coords: [{ label: 'King St, Newtown', lat: -33.8963, lng: 151.1815 }]
  }),
  q('SQ26', 'Exploration Region', 'Alt Kid', 25, {
    description: 'Take an edited selfie that gives 80s vibes in front of Dangerfield Newtown.',
    flavour: 'You were born in the wrong decade, and King St knows it.',
    location: 'Dangerfield, 232 King St, Newtown',
    coords: [{ label: 'Dangerfield Newtown', lat: -33.8969, lng: 151.1797 }]
  }),
  q('SQ27', 'Exploration Region', 'Where Shall We Walk and Talk?', 100, {
    description: 'Give the correct answer and a photo of the team next to the source of the question.',
    location: 'Wendy Whiteley’s Secret Garden, Lavender Bay',
    coords: [{ label: 'Wendy Whiteley’s Secret Garden', lat: -33.8437, lng: 151.2049 }],
    submit: 'text', prompt: 'Your answer'
  }),
  q('SQ28', 'Exploration Region', 'Across the Coathanger', 100, {
    description: 'Walk or run across the Harbour Bridge. Prove it with a photo at the start, middle and end of your walk.',
    location: 'Sydney Harbour Bridge',
    coords: [{ label: 'Sydney Harbour Bridge', lat: -33.8523, lng: 151.2108 }]
  }),
  q('SQ29', 'Exploration Region', 'Make a Face!', 25, {
    description: 'Standing underneath the Luna Park face, have one member make the wackiest face they can think of.',
    location: 'Luna Park, Milsons Point',
    coords: [{ label: 'Luna Park', lat: -33.8477, lng: 151.2098 }]
  }),
  q('SQ30', 'Exploration Region', 'Bicentennial View', 50, {
    description: 'Take a photo from the top of the Treillage Tower.',
    location: 'Treillage Tower, Bicentennial Park, Sydney Olympic Park',
    coords: [{ label: 'Treillage Tower', lat: -33.8452, lng: 151.0770 }]
  }),
  q('SQ31', 'Exploration Region', 'Spin Me Right Round', 50, {
    description: 'Take a spinning video of your surroundings at the top of the spiral hill.',
    flavour: 'Like a record, baby.',
    location: 'Bay Marker, Wentworth Point',
    coords: [{ label: 'Bay Marker, Wentworth Point', lat: -33.8270, lng: 151.0740 }]
  }),
  q('SQ32', 'Exploration Region', 'Have a Drink!', 200, {
    description: 'Time to hydrate! Send a picture of your team drinking water in Freshwater. Lateral thinking is rewarded for this challenge.',
    flavour: 'Hydralyte in Freshwater. Somebody in OrgComm was very proud of this one.',
    location: 'Freshwater (beach or village)',
    coords: [{ label: 'Freshwater', lat: -33.7827, lng: 151.2880 }]
  }),
  q('SQ33', 'Exploration Region', 'The Second Coming of Scomo', 175, {
    description: 'Take a video of one teammate saying "I don’t hold a hose, mate" outside the McDonald’s.',
    location: 'McDonald’s Engadine, 1042 Old Princes Hwy, Engadine',
    coords: [{ label: 'McDonald’s Engadine', lat: -34.0651, lng: 151.0125 }]
  }),
  q('SQ34', 'Exploration Region', 'Look Ma, I’m a Professional!', 50, {
    description: 'Pretend to play a sport outside the SCG and Allianz Stadium. Everyone must pretend (except the person recording).',
    location: 'Driver Ave, Moore Park',
    coords: [{ label: 'SCG', lat: -33.8917, lng: 151.2247 }, { label: 'Allianz Stadium', lat: -33.8892, lng: 151.2253 }]
  }),
  q('SQ35', 'Exploration Region', 'Nice House, Old Man!', 50, {
    description: 'Visit Old Government House in Parramatta, the oldest surviving public building in Australia and home to the first governors of the colony of New South Wales.',
    location: 'Old Government House, Parramatta Park',
    coords: [{ label: 'Old Government House', lat: -33.8123, lng: 151.0007 }]
  }),
  q('SQ36', 'Exploration Region', 'Westfield Empire!', 50, {
    description: 'Visit the first ever Westfield, Westpoint Blacktown!',
    location: 'Westpoint Blacktown',
    coords: [{ label: 'Westpoint Blacktown', lat: -33.7690, lng: 150.9060 }]
  }),
  q('SQ37', 'Exploration Region', 'The OG Bro', 175, {
    description: 'Visit the first Fried Brothers ever opened at their Food Truck in Mount Druitt!',
    location: 'Fried Brothers, Mount Druitt',
    coords: [{ label: 'Fried Brothers, Mount Druitt', lat: -33.7710, lng: 150.8190 }]
  }),
  q('SQ38', 'Exploration Region', 'Supermarket Time Travel', 50, {
    description: 'Visit the famous retro Woolworths in Eastwood.',
    flavour: 'The 90s called, it wants its Woolies back.',
    location: 'Woolworths Eastwood',
    coords: [{ label: 'Woolworths Eastwood', lat: -33.7900, lng: 151.0810 }]
  }),
  q('SQ39', 'Exploration Region', 'The Eight Summits', 50, {
    description: 'Sydney is full of "Mount" named suburbs that are not mountains. Photograph the team at as many as you can.\n\n**Points awarded for visiting:** 1, 2 or 3+ Mount suburbs. Highest tier reached, plus an additional bonus for visiting Mount Druitt.',
    flavour: 'No oxygen tanks required for these 8 Mountains!',
    location: 'Various "Mount" suburbs',
    submit: 'text', prompt: 'Which Mount suburb is this?',
    codes: [
      { code: 'SQ39', label: 'Mount suburbs', points: 175, scoring: 'tiered',
        bands: [{ from: 1, points: 50 }, { from: 2, points: 100 }, { from: 3, points: 175 }] },
      { code: 'SQ39-M', label: 'Mount Druitt bonus', points: 50 }
    ]
  }),
  q('SQ40', 'Exploration Region', 'Wondabyne', 950, {
    description: 'Australia’s only station with no road access. Photograph your whole team on the platform.\n\n**Note:** request stop, board the rear carriage and tell the guard.\n\n**Bonus:** For this quest proof of taking public transport from Central to Wondabyne is required.',
    flavour: 'There are no roads, no shops, and now one reason to be there. Perfect.',
    location: 'Wondabyne Station',
    coords: [{ label: 'Wondabyne Station', lat: -33.4939, lng: 151.2506 }]
  }),

  // ---- Cultural Region ----
  q('SQ41', 'Cultural Region', 'A Very Chinese Time Of My Life', 125, {
    description: 'Film two teammates having this conversation in Chinese (Mandarin or Cantonese), it doesn’t need to be good, at Hurstville Plaza or Burwood Chinatown:\n\n“nǐ jiào shénme míngzi?”\n“wǒ jiào {teammate name}”\n“nǐ shì nǎge guójiā de?”\n“wǒ lái zì {country in Chinese}.”\n\nMay be completed at both locations.\n\n**Note:** must be at the location specified.',
    location: 'Hurstville Plaza or Burwood Chinatown',
    coords: [{ label: 'Hurstville Plaza', lat: -33.9673, lng: 151.1023 }, { label: 'Burwood Chinatown', lat: -33.8775, lng: 151.1039 }],
    submit: 'codes', prompt: 'Where did you do it?',
    codes: [{ code: 'SQ41-H', label: 'Hurstville', points: 125 }, { code: 'SQ41-B', label: 'Burwood', points: 100 }]
  }),
  q('SQ42', 'Cultural Region', 'A Very Vietnamese Time of My Life', 150, {
    description: 'Film two teammates having this conversation in Vietnamese (it doesn’t need to be good) at Cabramatta or Marrickville:\n\n“Chào, tên tôi là {your name}.”\n“Chào {teammate’s name}, hôm nay là một ngày thật đẹp.”\n“Tôi đồng ý.”\n“Bạn có biết cách phát âm từ ‘Nguyen’ không?”\n\nMay be completed at both locations.',
    location: 'Cabramatta or Marrickville',
    coords: [{ label: 'Cabramatta', lat: -33.8945, lng: 150.9358 }, { label: 'Marrickville', lat: -33.9110, lng: 151.1550 }],
    submit: 'codes', prompt: 'Where did you do it?',
    codes: [{ code: 'SQ42-C', label: 'Cabramatta', points: 150 }, { code: 'SQ42-M', label: 'Marrickville', points: 125 }]
  }),
  q('SQ43', 'Cultural Region', 'A Very Turkish Time of My Life', 175, {
    description: 'Turkish, on Auburn Rd.\n\n“Merhaba, nasılsın?” (Hello, how are you?)\n“İyiyim, teşekkür ederim. Sen nasılsın?” (I’m well, thank you. And you?)\n“Açım. Pide yiyelim mi?” (I’m hungry. Shall we get pide?)',
    location: 'Auburn Rd, Auburn',
    coords: [{ label: 'Auburn Rd, Auburn', lat: -33.8500, lng: 151.0330 }]
  }),
  q('SQ44', 'Cultural Region', 'A Very Assyrian Time of My Life', 200, {
    description: 'Fairfield is home to one of the largest Assyrian communities anywhere outside the Middle East. Learn and say, on camera:\n\n“Shlama illokh / illakh” (Peace be upon you, male/female)\n“Basima raba” (Thank you very much)\n\n**Bonus:** Photograph an Assyrian flag flying somewhere in Fairfield.',
    location: 'Fairfield',
    coords: [{ label: 'Fairfield', lat: -33.8710, lng: 150.9560 }],
    submit: 'codes', prompt: 'What does this submission cover?',
    codes: [{ code: 'SQ44', label: 'The conversation', points: 200 }, { code: 'SQ44-B', label: 'Assyrian flag bonus', points: 25 }]
  }),
  q('SQ45', 'Cultural Region', 'A Very Hindi Time of My Life', 125, {
    description: 'Hindi on Wigram St, Harris Park:\n\n“नमस्ते, आपका नाम क्या है?” (Namaste, aapka naam kya hai?) — Hello, what’s your name?\n“मेरा नाम {name} है।” (Mera naam {name} hai.) — My name is {name}.\n“मुझे भूख लगी है।” (Mujhe bhookh lagi hai.) — I’m hungry.',
    location: 'Wigram St, Harris Park',
    coords: [{ label: 'Wigram St, Harris Park', lat: -33.8235, lng: 151.0050 }]
  }),

  // ---- Macquarie Region ----
  q('SQ46', 'Macquarie Region', 'The Macquaries of Sydney', 100, {
    description: 'There’s a LOT of things in Sydney named Macquarie, let’s visit them! Visit as many of the following places as possible:\n\n- Macquarie Lighthouse\n- Macquarie Uni (logo of the uni must be in the photo)\n- Macquarie Park (station sign)\n- Macquarie Street (street sign)\n- Macquarie Place Park (include the monument at the park)\n- Macquarie Centre (logo of the shopping centre, or in front of a recognisable part of the centre)\n- Macquarie Fields (station sign counts)\n- Macquarie Bank (logo, sign or directory listing with the company name)\n- Mrs Macquarie’s Chair\n- Governor Macquarie Tower\n- Macquarie Hospital (hospital sign)',
    location: 'All over Sydney',
    coords: [
      { label: 'Macquarie Lighthouse', lat: -33.8586, lng: 151.2850 },
      { label: 'Macquarie University', lat: -33.7738, lng: 151.1126 },
      { label: 'Macquarie Park Station', lat: -33.7770, lng: 151.1240 },
      { label: 'Macquarie St, Sydney', lat: -33.8680, lng: 151.2130 },
      { label: 'Macquarie Place Park', lat: -33.8623, lng: 151.2100 },
      { label: 'Macquarie Centre', lat: -33.7766, lng: 151.1188 },
      { label: 'Macquarie Fields Station', lat: -33.9926, lng: 150.8917 },
      { label: 'Macquarie Bank, 1 Elizabeth St', lat: -33.8677, lng: 151.2110 },
      { label: 'Mrs Macquarie’s Chair', lat: -33.8587, lng: 151.2222 },
      { label: 'Governor Macquarie Tower, 1 Farrer Pl', lat: -33.8650, lng: 151.2120 },
      { label: 'Macquarie Hospital', lat: -33.7930, lng: 151.1180 }
    ],
    submit: 'codes', prompt: 'Which Macquaries did you visit?',
    codes: [
      { code: 'SQ46-1', label: 'Macquarie Lighthouse', points: 100 },
      { code: 'SQ46-2', label: 'Macquarie Uni', points: 25 },
      { code: 'SQ46-3', label: 'Macquarie Park', points: 25 },
      { code: 'SQ46-4', label: 'Macquarie Street', points: 25 },
      { code: 'SQ46-5', label: 'Macquarie Place Park', points: 25 },
      { code: 'SQ46-6', label: 'Macquarie Centre', points: 25 },
      { code: 'SQ46-7', label: 'Macquarie Fields', points: 175 },
      { code: 'SQ46-8', label: 'Macquarie Bank', points: 25 },
      { code: 'SQ46-9', label: 'Mrs Macquarie’s Chair', points: 50 },
      { code: 'SQ46-10', label: 'Governor Macquarie Tower', points: 25 },
      { code: 'SQ46-11', label: 'Macquarie Hospital', points: 25 }
    ]
  }),
  q('SQ47', 'Macquarie Region', 'I Am Macquarie', 200, {
    description: 'Visit ALL of the Macquaries above.',
    location: 'Everywhere, apparently'
  }),
  q('SQ48', 'Macquarie Region', 'I Am REALLY Macquarie', 950, {
    description: 'Visit Lake Macquarie.',
    location: 'Lake Macquarie (Morisset Station)',
    coords: [{ label: 'Morisset Station', lat: -33.1080, lng: 151.4870 }]
  }),

  // ---- Unashamed Region ----
  q('SQ49', 'Unashamed Region', 'The Conga', 25, {
    description: 'Recruit strangers into a conga line. Points per non-team participant, up to 500.\n\n**Note:** You can only have one conga line count for this submission, but you may override prior submissions.',
    location: 'Anywhere',
    submit: 'count', prompt: 'How many strangers joined?',
    codes: [{ code: 'SQ49', label: 'Per stranger, max 500', points: 25, scoring: 'unit', most: 20 }]
  }),
  q('SQ50', 'Unashamed Region', 'Silent Disco', 100, {
    description: 'The whole team (minus the person filming) dances with total commitment for sixty unbroken seconds in a busy public place, no music, no phones out, no explanation to anyone.',
    location: 'Any busy public place'
  }),
  q('SQ51', 'Unashamed Region', 'Free Concert?', 75, {
    description: 'Record your team singing both verses of the Australian National Anthem outside the Sydney Opera House.\n\n**Bonus (Wrong National Anthem):** As above, but anywhere, singing the first verse only of the New Zealand National Anthem, first in Māori, then in English.',
    location: 'Sydney Opera House forecourt, Bennelong Point',
    coords: [{ label: 'Sydney Opera House', lat: -33.8568, lng: 151.2153 }],
    submit: 'codes', prompt: 'Which anthem?',
    codes: [{ code: 'SQ51', label: 'Australian anthem at the Opera House', points: 75 }, { code: 'SQ51-B', label: 'Wrong National Anthem bonus', points: 125 }]
  }),
  q('SQ52', 'Unashamed Region', 'Overplayed', 50, {
    description: 'Find a public piano anywhere and play one of the following for at least 8 seconds: Canon in D (Pachelbel), Für Elise (Beethoven), the Rickroll, or Rush E (Sheet Music Boss).',
    location: 'Any public piano'
  }),
  q('SQ53', 'Unashamed Region', 'The Petition', 25, {
    description: 'Convince as many strangers as possible to sign an absurd petition, something impossible, already done, or insanely specific. Points per signature, up to 500.',
    location: 'Anywhere',
    submit: 'count', prompt: 'How many signatures?',
    codes: [{ code: 'SQ53', label: 'Per signature, max 500', points: 25, scoring: 'unit', most: 20 }]
  }),
  q('SQ54', 'Unashamed Region', '#1 Uni In Australia', 100, {
    description: 'Go to the USYD campus and proudly proclaim, at full volume, "UNSW IS THE NUMBER ONE UNI IN AUSTRALIA!"',
    flavour: 'The only time we will proudly say UNSW #1.',
    location: 'University of Sydney (Quadrangle recommended)',
    coords: [{ label: 'University of Sydney Quadrangle', lat: -33.8886, lng: 151.1873 }]
  }),
  q('SQ55', 'Unashamed Region', 'Democracy Manifest', 50, {
    description: 'Outside any Chinese restaurant, re-enact the "succulent Chinese meal" video, "Gentlemen, this is democracy manifest!"',
    flavour: 'What is the charge? Completing a side quest? A succulent side quest?',
    location: 'Any Chinese restaurant'
  }),
  q('SQ56', 'Unashamed Region', 'Back in the 1800s…', 100, {
    description: 'Act out a 15-second video of being Australian farmers at Elizabeth Farm. Everyone else has to be the farm animals (except the person filming).',
    location: 'Elizabeth Farm, 70 Alice St, Rosehill',
    coords: [{ label: 'Elizabeth Farm', lat: -33.8180, lng: 151.0179 }]
  }),
  q('SQ57', 'Unashamed Region', 'Pushing Up', 50, {
    description: 'Do 10 pushups in public and have at least 1 person of the public be there watching.',
    location: 'Anywhere'
  }),
  q('SQ58', 'Unashamed Region', 'Day Drinker?', 100, {
    description: 'Buy an alcoholic drink from a pub and drink it. Challenge only open between 10am and 2pm. Must show receipt.',
    location: 'Anywhere'
  }),
  q('SQ59', 'Unashamed Region', 'TikTok Dancer', 100, {
    description: 'Film a TikTok dance (at least 10 seconds) in public, any dance, any song, all members of the team must take part.',
    location: 'Anywhere'
  }),
  q('SQ60', 'Unashamed Region', 'Beach Day Swim', 200, {
    description: 'Take a swim at a beach in full clothes (shoes not required, swimming clothes don’t count). The whole body must enter the water including the head. Must be at a beach.',
    location: 'Any beach'
  }),
  q('SQ61', 'Unashamed Region', 'How Much Boba Was In My Drink?', 100, {
    description: 'Buy a milk tea boba, open it, and hand-count how many pearls are inside. You must not make a mess of the area **(importantly)**.\n\n**Bonus:** Record your team reassembling the drink when done and get a team member to drink it.',
    flavour: 'Science demands sacrifice. Today, the sacrifice is one lukewarm, thoroughly-fingered milk tea…',
    location: 'Anywhere',
    submit: 'codes', prompt: 'What does this submission cover?',
    codes: [{ code: 'SQ61', label: 'The count', points: 100 }, { code: 'SQ61-B', label: 'Reassembled and drunk', points: 100 }]
  }),
  q('SQ62', 'Unashamed Region', 'Tell Him He’s Dreaming', 50, {
    description: 'Re-enact "The Castle": stand outside any real estate agent and deliver "Tell him he’s dreaming."',
    flavour: 'It’s not a challenge. It’s the vibe of the thing.',
    location: 'Any real estate business'
  }),

  // ---- Physical Region ----
  q('SQ63', 'Physical Region', 'Slow Rail!', 125, {
    description: 'Get off the Light Rail at Haymarket, then, on foot, run to Town Hall to board the same Light Rail vehicle. You must film this. Do this at your own risk and obey all road rules, no cheating, you must run or walk.\n\nProof requires at least 2 people: one films you getting off at Haymarket and then films the whole ride, ending with you re-boarding. The runner must take a selfie at Chinatown Light Rail (blurry is fine). Only one person needs to race, but as many may join as want to.',
    location: 'Haymarket Light Rail stop',
    coords: [{ label: 'Haymarket Light Rail', lat: -33.8809, lng: 151.2043 }]
  }),
  q('SQ64', 'Physical Region', 'Milk Mile', 225, {
    description: 'Run a Milk Mile at any running track (at your own risk!): drink 1 L of milk, then run 4 laps of a 400 m track.\n\n**Bonus:** Keep the empty milk carton and then deliver it to OrgComm before the Award Ceremony.',
    flavour: 'Lactose will not be the only thing that’s intolerable.',
    location: 'Any 400 m athletics track',
    submit: 'codes', prompt: 'What does this submission cover?',
    codes: [{ code: 'SQ64', label: 'The mile', points: 225 }, { code: 'SQ64-B', label: 'Carton delivered', points: 100 }]
  }),
  q('SQ65', 'Physical Region', 'Rock Skipping', 100, {
    description: 'Skip a rock 3 or more times on water and film it.',
    location: 'Any suitable body of water'
  }),
  q('SQ66', 'Physical Region', 'First Person To Hakk At…', 100, {
    description: 'Film your team hakking to the following song at a place you wouldn’t expect people to hakk at.',
    flavour: 'I’ll see you at Epik 2026. — Andrew',
    location: 'Anywhere'
  }),

  // ---- Region 11 ----
  q('SQ67', 'Region 11', 'Op Shop Makeover', 200, {
    description: 'Assemble a full outfit for one teammate for under $20 at an op shop. They wear it for the rest of the day. Receipt required.\n\n**Bonus:** Bonus points for (not included within the above $20 limit, but still must be from an op shop) buying new shoes, buying new jewelry, buying a hat.',
    flavour: 'Fashion is temporary. The $4 blazer is forever.',
    location: 'Any op shop',
    submit: 'codes', prompt: 'What did you buy?',
    codes: [
      { code: 'SQ67', label: 'The outfit', points: 200 },
      { code: 'SQ67-S', label: 'Shoes', points: 50 },
      { code: 'SQ67-J', label: 'Jewelry', points: 50 },
      { code: 'SQ67-H', label: 'Hat', points: 50 }
    ]
  }),
  q('SQ68', 'Region 11', 'Beach Day!', 150, {
    description: 'Build a sandcastle at a beach accessible by public transport and take a photo of it including all your team members.',
    location: 'Any beach'
  }),
  q('SQ69', 'Region 11', 'Strike a Pose', 25, {
    description: 'Take a photo with one or more members mimicking the pose of a statue, or of a model on a sign or billboard.',
    location: 'Anywhere'
  }),
  q('SQ70', 'Region 11', 'High School Memories', 75, {
    description: 'Take a group photo in front of any of your team members’ ex-high school. Proof of high school required. You may visit as many teammates’ high schools as possible, provided they are different from each other.',
    submit: 'text', prompt: 'Which school, and whose?',
    codes: [{ code: 'SQ70', label: 'Per school', points: 75, scoring: 'unit' }]
  }),
  q('SQ71', 'Region 11', 'Living the High Life!', 5, {
    description: 'Sydney might not be known for skyscrapers, but your goal is to reach the highest floor level possible in any building in Sydney. Take a photo of your whole group with proof of the floor level (e.g. elevator panel or building map). Do not trespass while completing this challenge. You receive 5 points per floor reached.',
    location: 'Any legally accessible tall building',
    submit: 'count', prompt: 'Which floor did you reach?',
    codes: [{ code: 'SQ71', label: 'Per floor', points: 5, scoring: 'unit' }]
  }),
  q('SQ72', 'Region 11', 'Playground Regression', 50, {
    description: 'Photograph your whole team at the bottom of a single slide.',
    flavour: 'You are all adults. The slide does not care.',
    location: 'Any playground'
  })
];
