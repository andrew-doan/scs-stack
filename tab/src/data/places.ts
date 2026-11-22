// Place lists the submit page offers when a quest's answer box says
// @stations or @sushi. Served with the quest list (/api/questlist).

var STATION_LIST = [
  // Sydney Trains
  'Allawah', 'Arncliffe', 'Artarmon', 'Ashfield', 'Asquith', 'Auburn', 'Banksia', 'Bankstown',
  'Bardwell Park', 'Beecroft', 'Berala', 'Berowra', 'Beverly Hills', 'Bexley North', 'Birrong',
  'Blacktown', 'Bondi Junction', 'Burwood', 'Cabramatta', 'Campbelltown', 'Canley Vale',
  'Caringbah', 'Carlton', 'Carramar', 'Casula', 'Central', 'Chatswood', 'Cheltenham',
  'Chester Hill', 'Circular Quay', 'Clarendon', 'Clyde', 'Como', 'Concord West', 'Cronulla',
  'Croydon', 'Denistone', 'Domestic Airport', 'Doonside', 'East Hills', 'East Richmond',
  'Eastwood', 'Edgecliff', 'Edmondson Park', 'Emu Plains', 'Engadine', 'Epping', 'Erskineville',
  'Fairfield', 'Flemington', 'Glenfield', 'Gordon', 'Granville', 'Green Square', 'Guildford',
  'Gymea', 'Harris Park', 'Heathcote', 'Helensburgh', 'Holsworthy', 'Homebush', 'Hornsby',
  'Hurstville', 'Ingleburn', 'International Airport', 'Jannali', 'Killara', 'Kings Cross',
  'Kingsgrove', 'Kingswood', 'Kirrawee', 'Kogarah', 'Leightonfield', 'Leppington', 'Leumeah',
  'Lewisham', 'Lidcombe', 'Lindfield', 'Liverpool', 'Loftus', 'Macarthur', 'Macdonaldtown',
  'Macquarie Fields', 'Marayong', 'Martin Place', 'Mascot', 'Meadowbank', 'Merrylands',
  'Milsons Point', 'Minto', 'Miranda', 'Mortdale', 'Mount Colah', 'Mount Druitt',
  'Mount Kuring-gai', 'Mulgrave', 'Museum', 'Narwee', 'Newtown', 'Normanhurst',
  'North Strathfield', 'North Sydney', 'Oatley', 'Olympic Park', 'Padstow', 'Panania',
  'Parramatta', 'Pendle Hill', 'Pennant Hills', 'Penrith', 'Penshurst', 'Petersham', 'Pymble',
  'Quakers Hill', 'Redfern', 'Regents Park', 'Revesby', 'Rhodes', 'Richmond', 'Riverstone',
  'Riverwood', 'Rockdale', 'Rooty Hill', 'Roseville', 'Schofields', 'Sefton', 'Seven Hills',
  'St James', 'St Leonards', 'St Marys', 'St Peters', 'Stanmore', 'Strathfield', 'Summer Hill',
  'Sutherland', 'Sydenham', 'Tempe', 'Thornleigh', 'Toongabbie', 'Town Hall', 'Turramurra',
  'Turrella', 'Villawood', 'Vineyard', 'Wahroonga', 'Waitara', 'Warrawee', 'Warwick Farm',
  'Waterfall', 'Waverton', 'Wentworthville', 'Werrington', 'West Ryde', 'Westmead', 'Windsor',
  'Wolli Creek', 'Wollstonecraft', 'Woolooware', 'Wynyard', 'Yagoona', 'Yennora',
  // Metro
  'Tallawong', 'Rouse Hill', 'Kellyville', 'Bella Vista', 'Norwest', 'Hills Showground',
  'Castle Hill', 'Cherrybrook', 'Macquarie University', 'Macquarie Park', 'North Ryde',
  'Crows Nest', 'Victoria Cross', 'Barangaroo', 'Gadigal', 'Waterloo', 'Marrickville',
  'Dulwich Hill', 'Hurlstone Park', 'Canterbury', 'Campsie', 'Belmore', 'Lakemba', 'Wiley Park',
  'Punchbowl',
  // Light rail
  'Arlington', 'Bank Street', 'Benaud Oval', 'Bridge Street', 'Capitol Square', 'Carlingford',
  'Central Chalmers Street', 'Central Grand Concourse', 'Childrens Hospital', 'Chinatown',
  'Church Street', 'Convention', 'Dulwich Grove', 'Dundas', 'ES Marks', 'Exhibition Centre',
  'Fennell Street', 'Glebe', 'Hawthorne', 'Haymarket', 'John Street Square', 'Jubilee Park',
  'Juniors Kingsford', 'Kensington', 'Kingsford', 'Leichhardt North', 'Lewisham West',
  'Lilyfield', 'Marion', 'Moore Park', 'Ngara', "Paddy's Markets", 'Parramatta Square',
  'Prince Alfred Square', 'Pyrmont Bay', 'QVB', 'Randwick', 'Robin Thomas', 'Rosehill Gardens',
  'Royal Randwick', 'Rozelle Bay', 'Surry Hills', 'Taverners Hill', 'Telopea', 'The Star',
  'Tramway Avenue', 'UNSW Anzac Parade', 'UNSW High Street', 'Wansey Road', 'Waratah Mills',
  'Wentworth Park', 'Westmead Hospital', 'Yallamundi'
];

var SUSHI_LIST = [
  'Balmain', 'Mt Druitt – Westfield', 'City – Westfield Sydney', 'Top Ryde City Centre 2 (Outside Woolworths)',
  'Merrylands – Stockland', 'Eastgardens – Westfield', 'Rhodes Waterside', 'Liverpool – Westfield 2',
  'Charlestown Square', 'Westfield Chatswood', 'Kiama Village', 'Lismore Square', 'City – Australia Square',
  'Menai – HomeCo. Menai Marketplace', 'Winmalee Village Shopping Centre', 'Oran Park',
  'North Sydney – Victoria Cross', 'Bankstown Central 2', 'Bondi – Westfield', 'Gosford – Imperial Shopping Centre',
  'Batemans Bay – Village Centre', 'Nowra Mall', 'Gables', 'Salamander Bay Square', 'Carnes Hill Marketplace',
  'St Marys Village', 'Shellharbour – Stockland 2', 'Five Dock', '25 Martin Place', 'Minto', 'Box Hill Square',
  'Carlingford Court', 'Piccadilly – Stockland', 'RNSH', 'Bankstown Central', 'Bass Hill Plaza',
  'Bateau Bay Square', 'Baulkham Hills – Grove Square', 'Blacktown – Westpoint 1 (Level 3 foodcourt)',
  'Blacktown – Westpoint 2 (Near Coles)', 'Brookvale – Westfield Warringah Mall', 'Burwood – Westfield',
  'Cabramatta', 'Cabramatta Plaza', 'Caddens Corner', 'Campbelltown – Macarthur Square', 'Campbelltown Mall',
  'Castle Hill – Castle Towers', 'Casula Mall', 'Chatswood', 'Chatswood Chase', 'City – 275 Kent Street',
  'City – 631 George Street', 'City – 815 George Street, Central', 'City – QVB', 'City – Skyview Plaza',
  'City – Townhall The Galeries', 'City – Wintergarden', 'City – World Square 2 (Outside Coles)',
  'Cranebrook Village', 'East Maitland – Stockland Green Hills', 'Eastern Creek Quarter', 'Eastwood',
  'Edmondson Park – Edmondson Square', 'Erina Fair', 'Shellharbour – Stockland',
  'Neutral Bay – Big Bear Shopping Centre', 'Manly Wharf Shopping Centre', 'Fairfield – Neeta City',
  'Hornsby – Westfield', 'Hurstville – Westfield', 'Hurstville – One Hurstville Plaza', 'Kotara – Westfield',
  'Lake Haven Shopping Centre', 'Liverpool – Westfield', 'Mt Annan Marketplace', 'Narellan Town Centre',
  'Norwest Marketown', 'Parramatta – Westfield', 'Penrith – Westfield', 'Plumpton Marketplace', 'Potts Point',
  'Richmond Marketplace', 'Rockdale Plaza', 'Sylvania – Southgate', 'Top Ryde City Centre (Outside Coles)',
  'Tuggerah – Westfield', 'Tweed Heads South – Tweed City', 'Wagga Wagga Marketplace', 'Warrawong Plaza',
  'West Gosford Village', 'Wetherill Park – Stockland', 'Woy Woy – Deepwater Plaza'
];

function sortedUnique(list: string[]): string[] {
  var seen: Record<string, boolean> = {};
  return list.filter(function (name) {
    if (seen[name]) return false;
    seen[name] = true;
    return true;
  }).sort(function (a, b) { return a.localeCompare(b); });
}

export var PLACES: { stations: string[]; sushi: string[] } = {
  stations: sortedUnique(STATION_LIST),
  sushi: sortedUnique(SUSHI_LIST)
};
