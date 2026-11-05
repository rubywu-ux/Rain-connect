/* Where is it raining? Names a point on Earth by its nearest well-known place,
   or by the sea / region it lies over when no city is near. Approximate, poetic,
   never shown as precise. Data: city coordinates rounded to ~0.1°. */
const PLACES = `Reykjavík|Iceland|64.1|-21.9;Nuuk|Greenland|64.2|-51.7;Tromsø|Norway|69.6|19.0;Oslo|Norway|59.9|10.8;Bergen|Norway|60.4|5.3;Stockholm|Sweden|59.3|18.1;Helsinki|Finland|60.2|24.9;Copenhagen|Denmark|55.7|12.6;
Dublin|Ireland|53.3|-6.3;London|UK|51.5|-0.1;Edinburgh|Scotland|55.9|-3.2;Paris|France|48.9|2.4;Brest|France|48.4|-4.5;Madrid|Spain|40.4|-3.7;Lisbon|Portugal|38.7|-9.1;Barcelona|Spain|41.4|2.2;Rome|Italy|41.9|12.5;Milan|Italy|45.5|9.2;
Berlin|Germany|52.5|13.4;Amsterdam|Netherlands|52.4|4.9;Vienna|Austria|48.2|16.4;Warsaw|Poland|52.2|21.0;Prague|Czechia|50.1|14.4;Budapest|Hungary|47.5|19.0;Athens|Greece|38.0|23.7;Istanbul|Türkiye|41.0|29.0;Ankara|Türkiye|39.9|32.9;
Kyiv|Ukraine|50.5|30.5;Moscow|Russia|55.8|37.6;St Petersburg|Russia|59.9|30.3;Murmansk|Russia|69.0|33.1;Yekaterinburg|Russia|56.8|60.6;Novosibirsk|Russia|55.0|82.9;Norilsk|Russia|69.3|88.2;Yakutsk|Russia|62.0|129.7;Magadan|Russia|59.6|150.8;Vladivostok|Russia|43.1|131.9;Petropavlovsk-Kamchatsky|Russia|53.0|158.6;
Cairo|Egypt|30.0|31.2;Tripoli|Libya|32.9|13.2;Tunis|Tunisia|36.8|10.2;Algiers|Algeria|36.8|3.1;Casablanca|Morocco|33.6|-7.6;Dakar|Senegal|14.7|-17.4;Bamako|Mali|12.6|-8.0;Timbuktu|Mali|16.8|-3.0;Niamey|Niger|13.5|2.1;Agadez|Niger|17.0|8.0;Lagos|Nigeria|6.5|3.4;Abuja|Nigeria|9.1|7.4;Accra|Ghana|5.6|-0.2;Abidjan|Côte d'Ivoire|5.3|-4.0;Monrovia|Liberia|6.3|-10.8;Freetown|Sierra Leone|8.5|-13.2;
N'Djamena|Chad|12.1|15.0;Khartoum|Sudan|15.6|32.5;Juba|South Sudan|4.9|31.6;Addis Ababa|Ethiopia|9.0|38.7;Mogadishu|Somalia|2.0|45.3;Nairobi|Kenya|-1.3|36.8;Kampala|Uganda|0.3|32.6;Kisangani|DR Congo|0.5|25.2;Kinshasa|DR Congo|-4.3|15.3;Libreville|Gabon|0.4|9.5;Douala|Cameroon|4.1|9.7;Bangui|Central African Republic|4.4|18.6;
Luanda|Angola|-8.8|13.2;Lusaka|Zambia|-15.4|28.3;Harare|Zimbabwe|-17.8|31.0;Dar es Salaam|Tanzania|-6.8|39.3;Maputo|Mozambique|-26.0|32.6;Beira|Mozambique|-19.8|34.9;Antananarivo|Madagascar|-18.9|47.5;Windhoek|Namibia|-22.6|17.1;Gaborone|Botswana|-24.7|25.9;Johannesburg|South Africa|-26.2|28.0;Cape Town|South Africa|-33.9|18.4;Durban|South Africa|-29.9|31.0;
Port Louis|Mauritius|-20.2|57.5;Victoria|Seychelles|-4.6|55.5;Malé|Maldives|4.2|73.5;Riyadh|Saudi Arabia|24.7|46.7;Jeddah|Saudi Arabia|21.5|39.2;Muscat|Oman|23.6|58.4;Dubai|UAE|25.2|55.3;Doha|Qatar|25.3|51.5;Tehran|Iran|35.7|51.4;Baghdad|Iraq|33.3|44.4;Sana'a|Yemen|15.4|44.2;Kabul|Afghanistan|34.5|69.2;Tashkent|Uzbekistan|41.3|69.2;Almaty|Kazakhstan|43.2|76.9;Astana|Kazakhstan|51.2|71.4;
Karachi|Pakistan|24.9|67.0;Lahore|Pakistan|31.5|74.3;Delhi|India|28.6|77.2;Mumbai|India|19.1|72.9;Kolkata|India|22.6|88.4;Chennai|India|13.1|80.3;Bengaluru|India|13.0|77.6;Kochi|India|9.9|76.3;Colombo|Sri Lanka|6.9|79.9;Kathmandu|Nepal|27.7|85.3;Dhaka|Bangladesh|23.8|90.4;Thimphu|Bhutan|27.5|89.6;
Yangon|Myanmar|16.8|96.2;Bangkok|Thailand|13.8|100.5;Chiang Mai|Thailand|18.8|99.0;Hanoi|Vietnam|21.0|105.8;Ho Chi Minh City|Vietnam|10.8|106.7;Phnom Penh|Cambodia|11.6|104.9;Vientiane|Laos|18.0|102.6;Kuala Lumpur|Malaysia|3.1|101.7;Singapore|Singapore|1.3|103.8;Kuching|Malaysia|1.6|110.3;Jakarta|Indonesia|-6.2|106.8;Medan|Indonesia|3.6|98.7;Surabaya|Indonesia|-7.3|112.7;Makassar|Indonesia|-5.1|119.4;Jayapura|Indonesia|-2.5|140.7;Manila|Philippines|14.6|121.0;Davao|Philippines|7.1|125.6;
Beijing|China|39.9|116.4;Shanghai|China|31.2|121.5;Guangzhou|China|23.1|113.3;Hong Kong|China|22.3|114.2;Chengdu|China|30.7|104.1;Wuhan|China|30.6|114.3;Kunming|China|25.0|102.7;Lhasa|China|29.7|91.1;Ürümqi|China|43.8|87.6;Harbin|China|45.8|126.6;Ulaanbaatar|Mongolia|47.9|106.9;Taipei|Taiwan|25.0|121.6;Seoul|South Korea|37.6|127.0;Tokyo|Japan|35.7|139.7;Osaka|Japan|34.7|135.5;Sapporo|Japan|43.1|141.4;Naha|Okinawa|26.2|127.7;
Sydney|Australia|-33.9|151.2;Melbourne|Australia|-37.8|145.0;Brisbane|Australia|-27.5|153.0;Cairns|Australia|-16.9|145.8;Darwin|Australia|-12.5|130.8;Perth|Australia|-31.9|115.9;Alice Springs|Australia|-23.7|133.9;Adelaide|Australia|-34.9|138.6;Hobart|Tasmania|-42.9|147.3;Auckland|New Zealand|-36.8|174.8;Christchurch|New Zealand|-43.5|172.6;Port Moresby|Papua New Guinea|-9.4|147.2;Honiara|Solomon Islands|-9.4|160.0;Nouméa|New Caledonia|-22.3|166.5;Port Vila|Vanuatu|-17.7|168.3;Suva|Fiji|-18.1|178.4;Apia|Samoa|-13.8|-171.8;Nuku'alofa|Tonga|-21.1|-175.2;Papeete|Tahiti|-17.5|-149.6;Tarawa|Kiribati|1.4|173.0;Majuro|Marshall Islands|7.1|171.4;Hagåtña|Guam|13.5|144.8;Honolulu|Hawaiʻi|21.3|-157.9;Easter Island|Chile|-27.1|-109.4;Galápagos|Ecuador|-0.7|-90.3;
Anchorage|Alaska|61.2|-149.9;Juneau|Alaska|58.3|-134.4;Utqiaġvik|Alaska|71.3|-156.8;Whitehorse|Canada|60.7|-135.1;Yellowknife|Canada|62.5|-114.4;Iqaluit|Canada|63.7|-68.5;Vancouver|Canada|49.3|-123.1;Seattle|USA|47.6|-122.3;Portland|USA|45.5|-122.7;San Francisco|USA|37.8|-122.4;Los Angeles|USA|34.1|-118.2;Las Vegas|USA|36.2|-115.1;Phoenix|USA|33.4|-112.1;Denver|USA|39.7|-105.0;Salt Lake City|USA|40.8|-111.9;Calgary|Canada|51.0|-114.1;Winnipeg|Canada|49.9|-97.1;Minneapolis|USA|45.0|-93.3;Chicago|USA|41.9|-87.6;Dallas|USA|32.8|-96.8;Houston|USA|29.8|-95.4;New Orleans|USA|30.0|-90.1;Atlanta|USA|33.7|-84.4;Miami|USA|25.8|-80.2;Washington DC|USA|38.9|-77.0;New York|USA|40.7|-74.0;Boston|USA|42.4|-71.1;Toronto|Canada|43.7|-79.4;Montréal|Canada|45.5|-73.6;Halifax|Canada|44.6|-63.6;St John's|Canada|47.6|-52.7;Hamilton|Bermuda|32.3|-64.8;
Mexico City|Mexico|19.4|-99.1;Guadalajara|Mexico|20.7|-103.3;Monterrey|Mexico|25.7|-100.3;Mérida|Mexico|21.0|-89.6;Guatemala City|Guatemala|14.6|-90.5;San José|Costa Rica|9.9|-84.1;Panama City|Panama|9.0|-79.5;Havana|Cuba|23.1|-82.4;Kingston|Jamaica|18.0|-76.8;Santo Domingo|Dominican Republic|18.5|-69.9;San Juan|Puerto Rico|18.5|-66.1;Port of Spain|Trinidad|10.7|-61.5;
Bogotá|Colombia|4.7|-74.1;Medellín|Colombia|6.2|-75.6;Caracas|Venezuela|10.5|-66.9;Quito|Ecuador|-0.2|-78.5;Guayaquil|Ecuador|-2.2|-79.9;Lima|Peru|-12.0|-77.0;Iquitos|Peru|-3.7|-73.2;Cusco|Peru|-13.5|-72.0;La Paz|Bolivia|-16.5|-68.1;Santa Cruz|Bolivia|-17.8|-63.2;Manaus|Brazil|-3.1|-60.0;Belém|Brazil|-1.5|-48.5;Fortaleza|Brazil|-3.7|-38.5;Recife|Brazil|-8.1|-34.9;Salvador|Brazil|-13.0|-38.5;Brasília|Brazil|-15.8|-47.9;Cuiabá|Brazil|-15.6|-56.1;Porto Velho|Brazil|-8.8|-63.9;Rio de Janeiro|Brazil|-22.9|-43.2;São Paulo|Brazil|-23.6|-46.6;Porto Alegre|Brazil|-30.0|-51.2;Asunción|Paraguay|-25.3|-57.6;Montevideo|Uruguay|-34.9|-56.2;Buenos Aires|Argentina|-34.6|-58.4;Córdoba|Argentina|-31.4|-64.2;Santiago|Chile|-33.4|-70.7;Antofagasta|Chile|-23.7|-70.4;Puerto Montt|Chile|-41.5|-72.9;Punta Arenas|Chile|-53.2|-70.9;Ushuaia|Argentina|-54.8|-68.3;Stanley|Falkland Islands|-51.7|-57.9;
Ponta Delgada|Azores|37.7|-25.7;Las Palmas|Canary Islands|28.1|-15.4;Praia|Cape Verde|14.9|-23.5;Jamestown|Saint Helena|-15.9|-5.7;Tristan da Cunha|South Atlantic|-37.1|-12.3;Grytviken|South Georgia|-54.3|-36.5;McMurdo Station|Antarctica|-77.8|166.7;Longyearbyen|Svalbard|78.2|15.6`
  .split(/;\s*/).map(r => { const [n, c, la, lo] = r.split('|'); return [n.trim(), c, +la, +lo]; });

function _gcKm(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}
/* land or sea: a 2° grid of the world (180 x 90 cells, 1 bit each), made from Natural Earth land */
const LAND_MASK = (() => {
  const b = atob('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAfAP8HAAAAAAAAAAAAAAAAAAAAAADo//z//wcAAAAAAAACAAAAAAAAAAAAhvvw//8PAPABAAAAwAMAAAAAAAAAwADkw////wEABAAAAABgAAAAAAAAAADAUT8A/v8PAAAAAAwA/j8AuAEAAAAAcBHtDcD/fwAAAAAwAPz/fwMAABCAAQD5w/wD8P8FAAAcAIL7//9//xOAAP/ff0668QD/HwAA+A8At///////v3/w/////x8++B8AAOD/1//7////////jP////+/+AE/gAcAn9f//////////w/w/////wEs4AEAAHz+////////////gL////8HeAAcAADg5///////////9ADgAf7/f4AnAAAAAH78////////H0QAAAiA//8f8AcAAIBB4////////38ADwAQAOD//5//AQAAHAT/////////A3AAAAAA/v//+T8AAGDz//////////8DAQAAAMD/////AwAAsP//////////LwAAAAAA6P///2IAAAD+//////////8CAAAAAAD///8/CAAA4P//////////JwAAAAAA8P///wYAAAD+/unz/////z8AAAAAAAD///8HAAAA/pgPPP//////MQAAAAAA8P//PwAAAMBD9v7n/////wcBAAAAAAD///8AAAAAPkD7f/7///8hEAAAAAAA4P//DwAAAIDhAv/n////f8YAAAAAAAD8//8AAAAA+AdE//////8jDwAAAAAAgP//AwAAAMD/APD/////PxgAAAAAAADw/x8AAAAA/n/v//////8HAAAAAAAAAPwDAgAAAOD////7////fwAAAAAAAACgHyAAAACA//9/f/7///8DAAAAAAAAAPQBAAAAAPj//+cv+P//PwAAAAAAAAAAHjAAAADA/////g/+//8EAAAAAAAAAOBhCAAAAP7//99/4D//AAAAAAAAAAAAPAMEAADA////+Qf84BcAAAAAAAAAAAA/AAAAAPz//58fgAf+QAAAAAAAAAAAAA8AAADg////ewA4gA8EAAAAAAAAAADAAAAAAPz//38BgAP4QQAAAAAAAAAAAAgPAADA////zwAwgAwQAAAAAAAAAAAA9Q8AAPj///8HAAVIAAAAAAAAAAAAAID/AQAA////fwBAAAAQAAAAAAAAAAAA+P8AAGDh//8DAAA0GAAAAAAAAAAAAID/HwAAAPj/HwAAgMIBAAAAAAAAAAAA/P8BAACA//8AAAAYXgAAAAAAAAAAAMD/fwAAAPz/BwAAAOOBAQAAAAAAAAAA/P8/AACA/z8AAABgbtQBAAAAAAAAAOD//w8AAPD/AwAAAAQIeAAAAAAAAAAA/P//AQAA/z8AAACAA4APAQAAAAAAAID//w8AAPD/AwAAAAARsEAAAAAAAAAA+P9/AAAA/j8AAAAAAAAAAAAAAAAAAAD//wcAAPD/QwAAAACAIwAAAAAAAAAA8P9/AAAA/z8EAAAAAD8GIAAAAAAAAAD8/wMAAPD/cQAAAAD4ZwAAAAAAAAAAgP8/AAAA/w8HAAAAgP8HAAAAAAAAAAD4/wMAAOD/MAAAAAD//wEBAAAAAAAAgP8PAAAA/g8DAAAA+P8fAAAAAAAAAAD4PwAAAOB/EAAAAID//wMAAAAAAAAAgP8DAAAA/AMAAAAA+P9/AAAAAAAAAAD8HwAAAMA/AAAAAID//wcAAAAAAAAAwP8BAAAA+AEAAAAA8P9/AAAAAAAAAAD8DwAAAIAPAAAAAAAP/gMAAAAAAAAAwB8AAAAAAAAAAAAAEIAfAAEAAAAAAAD+AwAAAAAAAAAAAAAA8AEgAAAAAAAA4AcAAAAAAAAAAAAAAAAAAAYAAAAAAABeAAAAAAAAAAAAAAAAwAAwAAAAAAAAwAMAAAAAAAAAAAAAAAAIgAEAAAAAAAAeAAAAAAAAAAAAAAAAAAAMAAAAAAAA4AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAAAAAAAAAAABAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAB4AEDwn/8HAAAAAAAAAAAwAAAAAACA/P/h/////w8AAAAAAAAAwAcAAAD4////z///////PwAAAAAAHALwAACA//////////////8HAADw/y///wMAAP7/////////////HwAA+P///38AAID///////////////8AAPL/////BwAO////////////////DwAA8P////8HEPD//////////////z8AAOD/////////////////////////H/AfwP//////////////////////////////////////////////////////////////////////////////////////');
  const out = new Uint8Array(b.length * 8);
  for (let i = 0; i < b.length; i++) { const v = b.charCodeAt(i); for (let k = 0; k < 8; k++) out[i * 8 + k] = (v >> k) & 1; }
  return out;
})();
function isLand(lat, lon) {
  const r = Math.min(89, Math.max(0, Math.round((89 - lat) / 2))), c = Math.min(179, Math.max(0, Math.round((lon + 179) / 2)));
  return LAND_MASK[r * 180 + c] === 1;
}
function _onLand(lat, lon) { return isLand(lat, lon); }
function _landName(lat, lon) {
  if (lat < -60) return 'over Antarctica';
  if (lon > -75 && lon < -10 && lat > 59) return 'over Greenland';
  if (lon < -140 && lat > 54) return 'over Alaska';
  if (lon > -170 && lon < -50 && lat > 20) return lat > 56 ? 'over northern Canada' : 'over North America';
  if (lon > -95 && lon < -77 && lat > 7 && lat <= 20) return 'over Central America';
  if (lon > -82 && lon < -30 && lat <= 13) return lat > -12 && lon < -48 ? 'over the Amazon' : 'over South America';
  if (lon > 43 && lon < 51 && lat > -26 && lat < -12) return 'over Madagascar';
  if (lon > -20 && lon < 52 && lat > -36 && lat < 37 && !(lon > 35 && lat > 12)) return lat > 15 ? 'over the Sahara' : lat > -5 ? 'over central Africa' : 'over southern Africa';
  if (lon > -12 && lon < 45 && lat >= 36) return 'over Europe';
  if (lon > 35 && lon < 62 && lat > 12 && lat < 32) return 'over the Arabian Peninsula';
  if (lon > 110 && lon < 155 && lat < -10) return 'over the Australian outback';
  if (lon > 130 && lon < 151 && lat > -11 && lat < 0) return 'over New Guinea';
  if (lat > 50 && lon > 45) return 'over Siberia';
  if (lon > 78 && lon < 100 && lat > 28 && lat < 37) return 'over the Tibetan Plateau';
  if (lon > 95 && lon < 125 && lat > -10 && lat < 28) return 'over Southeast Asia';
  if (lon > 100 && lon < 135 && lat >= 20) return 'over China';
  if (lon > 45 && lon < 100) return 'over central Asia';
  return 'over land';
}
function _seaName(lat, lon) {
  if (lat < -55) return 'over the Southern Ocean';
  if (lat > 70) return 'over the Arctic Ocean';
  if (lat > 5 && lat < 23 && lon > 80 && lon < 95) return 'over the Bay of Bengal';
  if (lat > 5 && lat < 25 && lon > 52 && lon < 76) return 'over the Arabian Sea';
  if (lat > 0 && lat < 23 && lon > 105 && lon < 121) return 'over the South China Sea';
  if (lat > -10 && lat < 8 && lon > 100 && lon < 141) return 'over the seas of Indonesia';
  if (lat > 18 && lat < 31 && lon > -98 && lon < -81) return 'over the Gulf of Mexico';
  if (lat > 9 && lat <= 22 && lon > -88 && lon < -60) return 'over the Caribbean Sea';
  if (lat > 30 && lat < 46 && lon > -6 && lon < 36) return 'over the Mediterranean';
  if (lat > 51 && lat < 66 && lon > -96 && lon < -76) return 'over Hudson Bay';
  if (lat > 51 && lat < 62 && lon > -4 && lon < 12) return 'over the North Sea';
  if (lat > 10 && lat < 30 && lon > 32 && lon < 44) return 'over the Red Sea';
  if (lat > 35 && lat < 60 && lon > 130 && lon < 157) return 'over the Sea of Japan and the Kurils';
  const n = lat >= 0 ? 'North' : 'South';
  if (lon > 20 && lat < 30 && (lon < 100 || (lat < -8 && lon < 147))) return 'over the Indian Ocean';
  const pacific = lon >= 100 || (lat > 8 ? lon < -85 : lon < -70);
  return pacific ? `over the ${n} Pacific` : `over the ${n} Atlantic`;
}
function _region(lat, lon) {
  const land = _onLand(lat, lon);
  if (land === true) return _landName(lat, lon);
  if (land === false) return _seaName(lat, lon);
  return _seaName(lat, lon);              // land shapes not loaded yet: most of Earth is sea
}
/* "near Hanoi, Vietnam" / "over the Bay of Bengal" */
function placeName(lat, lon) {
  let best = null, bd = 1e9;
  for (const p of PLACES) { const d = _gcKm(lat, lon, p[2], p[3]); if (d < bd) { bd = d; best = p; } }
  if (best && bd < 650) return { where: (bd < 120 ? 'in ' : 'near ') + best[0] + ', ' + best[1], km: Math.round(bd) };
  if (best && bd < 1100) return { where: _region(lat, lon) + ', ' + Math.round(bd / 50) * 50 + ' km from ' + best[0], km: Math.round(bd) };
  return { where: _region(lat, lon), km: Math.round(bd) };
}
/* what kind of rain, from the WMO weather code (falls back to the amount) */
const RAIN_WORDS = { 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 80: 'passing showers', 81: 'rain showers',
  82: 'a downpour', 95: 'a thunderstorm', 96: 'a thunderstorm with hail', 99: 'a thunderstorm with hail' };
function rainWords(mm, code) {
  if (code != null && RAIN_WORDS[code]) return RAIN_WORDS[code];
  return mm >= 4 ? 'heavy rain' : mm >= 1 ? 'rain' : 'light rain';
}
/* how strong the rain is, 0..1, for the size of its plume */
const RAIN_RANK = { 51: 0.15, 53: 0.25, 55: 0.35, 56: 0.3, 57: 0.4, 61: 0.35, 63: 0.6, 65: 0.85, 66: 0.45, 67: 0.75,
  80: 0.45, 81: 0.65, 82: 0.95, 95: 1, 96: 1, 99: 1 };
function rainStrength(mm, code) {
  const a = code != null && RAIN_RANK[code] != null ? RAIN_RANK[code] : 0.3;
  const b = mm != null ? Math.min(1, Math.sqrt(mm / 6)) : 0;
  return Math.max(0.12, Math.min(1, Math.max(a, b)));
}
