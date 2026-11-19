// Slash command definitions, used by the worker to route and by
// scripts/register.mjs to tell Discord what exists.
// Option type 3 = string, 7 = channel. Autocomplete pulls live team
// and quest names from the database, which sidesteps Discord's
// 25-choice limit.

const teamOption = {
  type: 3,
  name: 'team',
  description: 'Team name, as on the tab',
  required: true,
  autocomplete: true
};

const questOption = {
  type: 3,
  name: 'quest',
  description: 'Quest code: MQ2, S40, S22-Burwood, Make 21…',
  required: true,
  autocomplete: true
};

// On the read commands: send the answer to another channel instead of
// answering here. Organiser-only, enforced in the worker.
const channelOption = {
  type: 7,
  name: 'channel',
  description: 'Organisers: post the answer in this channel instead',
  required: false,
  channel_types: [0, 5] // text and announcement channels
};

export const COMMANDS = [
  {
    name: 'score',
    description: "A team's total points and where they sit",
    options: [teamOption, channelOption]
  },
  {
    name: 'leaderboard',
    description: 'The top 10, one place (3) or a stretch (3-10)',
    options: [{
      type: 3,
      name: 'place',
      description: 'A place like 3, or a range like 3-10',
      required: false
    }, channelOption]
  },
  {
    name: 'quest',
    description: 'Has a team done a quest?',
    options: [teamOption, questOption, channelOption]
  },
  {
    name: 'list',
    description: 'Everything the tab has recorded for a team',
    options: [teamOption, channelOption]
  },
  {
    name: 'submit',
    description: 'Record a quest completion on the tab',
    options: [teamOption, questOption]
  },
  {
    name: 'unsubmit',
    description: 'Take a quest completion back off the tab',
    options: [teamOption, questOption]
  },
  {
    name: 'verify',
    description: 'Link your Discord to your team signup: your team role and private channel'
  },
  {
    name: 'post',
    description: 'Have the bot post a message in a channel (organisers)',
    options: [
      {
        type: 7,
        name: 'channel',
        description: 'Where to post it',
        required: true,
        channel_types: [0, 5]
      },
      {
        type: 3,
        name: 'message',
        description: 'What to post. Write \\n where you want a line break',
        required: true,
        max_length: 2000
      }
    ]
  },
  {
    name: 'help',
    description: 'What the commands do'
  }
];
