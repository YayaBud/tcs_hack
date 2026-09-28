// OWNER: B. Stub with the agreed shape so the frontend runs. B replaces the contents.
const STREAMS = {
  wet:        { label: 'Wet waste',   bin: 'GREEN bin',              color: '#3d7a4f', emoji: '🍌' },
  dry:        { label: 'Dry waste',   bin: 'BLUE bin',               color: '#2f5d93', emoji: '🧴' },
  hazardous:  { label: 'Hazardous',   bin: 'Separate, never mix',   color: '#b0452e', emoji: '☣️' },
  'e-waste':  { label: 'E-waste',     bin: 'E-waste collector',      color: '#8a6418', emoji: '🔌' },
  unknown:    { label: 'Unknown',     bin: 'Ask local collector',    color: '#6b7280', emoji: '❓' },
};

const LEARN = {
  wet:       ['Fruit & veg peels', 'Leftover food', 'Tea leaves', 'Garden waste'],
  dry:       ['Plastic bottles', 'Paper & cardboard', 'Glass jars', 'Metal cans'],
  hazardous: ['Batteries', 'Medicines', 'Paint & chemicals', 'CFL bulbs'],
  'e-waste': ['Chargers & cables', 'Old phones', 'Earphones', 'Circuit boards'],
};
