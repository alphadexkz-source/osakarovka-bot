require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const key = process.env.DGIS_API_KEY;

async function test() {
  // Точно такой же запрос как в dgis.js
  const r = await axios.get('https://catalog.api.2gis.com/3.0/items', {
    params: {
      q: 'кафе',
      location: '72.5681,50.5619',
      radius: 8000,
      fields: 'items.point,items.address,items.rubrics,items.contact_groups,items.schedule',
      key,
      page_size: 10,
      page: 1,
      sort: 'distance',
    },
    timeout: 10000,
  });
  console.log('total:', r.data?.result?.total);
  console.log('items count:', r.data?.result?.items?.length);
  const item = r.data?.result?.items?.[0];
  if (item) {
    console.log('\nFirst item keys:', Object.keys(item));
    console.log('name:', item.name);
    console.log('address:', JSON.stringify(item.address));
    console.log('address_name:', item.address_name);
    console.log('rubrics:', JSON.stringify(item.rubrics?.slice(0,2)));
    console.log('point:', JSON.stringify(item.point));
  }
}

test().catch(e => console.error(e.response?.status, e.response?.data || e.message));
