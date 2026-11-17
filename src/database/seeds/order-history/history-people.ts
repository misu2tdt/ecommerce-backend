import { SeededRandom } from './history-random';

// Every seeded customer has an address at this domain. It is a subdomain of
// example.com (reserved by RFC 2606: it can never be a real mailbox), and the
// seed finds its own rows by it, so a rerun knows the history is already there.
export const HISTORY_EMAIL_DOMAIN = 'demo-history.example.com';

// Names are plain ASCII on purpose: the repository keeps Vietnamese letters out
// of source files. They mix Vietnamese and international names.
const FIRST_NAMES = [
  'Linh',
  'Minh',
  'Anh',
  'Huy',
  'Lan',
  'Nam',
  'Mai',
  'Duc',
  'Hoa',
  'Khanh',
  'Thao',
  'Phuong',
  'Quang',
  'Trang',
  'Hieu',
  'Ngoc',
  'Tuan',
  'Yen',
  'Bao',
  'Chi',
  'Emma',
  'Daniel',
  'Sophie',
  'Lucas',
  'Hannah',
  'Kenji',
  'Mina',
  'Oliver',
  'Isabella',
  'Jun',
  'Clara',
  'Marco',
  'Priya',
  'Noah',
  'Sofia',
  'Tom',
  'Grace',
  'Leo',
  'Amelie',
  'Ryan',
];

const LAST_NAMES = [
  'Nguyen',
  'Tran',
  'Le',
  'Pham',
  'Hoang',
  'Vu',
  'Dang',
  'Bui',
  'Do',
  'Ngo',
  'Duong',
  'Ly',
  'Smith',
  'Johnson',
  'Garcia',
  'Mueller',
  'Tanaka',
  'Kim',
  'Rossi',
  'Martin',
  'Nakamura',
  'Dubois',
  'Park',
  'Silva',
];

interface Place {
  city: string;
  districts: readonly string[];
}

const PLACES: readonly Place[] = [
  {
    city: 'Ho Chi Minh City',
    districts: [
      'District 1',
      'District 3',
      'District 7',
      'Binh Thanh',
      'Thu Duc',
    ],
  },
  {
    city: 'Hanoi',
    districts: ['Cau Giay', 'Dong Da', 'Ba Dinh', 'Hai Ba Trung'],
  },
  { city: 'Da Nang', districts: ['Hai Chau', 'Son Tra', 'Thanh Khe'] },
  { city: 'Can Tho', districts: ['Ninh Kieu', 'Cai Rang'] },
  { city: 'Hai Phong', districts: ['Le Chan', 'Ngo Quyen'] },
  { city: 'Nha Trang', districts: ['Loc Tho', 'Vinh Hai'] },
];

const STREETS = [
  'Le Loi',
  'Nguyen Hue',
  'Tran Hung Dao',
  'Hai Ba Trung',
  'Pasteur',
  'Dien Bien Phu',
  'Vo Van Tan',
  'Ly Thuong Kiet',
  'Nguyen Trai',
  'Pham Ngu Lao',
  'Lac Long Quan',
  'Hoang Dieu',
];

const MOBILE_PREFIXES = [
  '90',
  '91',
  '93',
  '97',
  '98',
  '32',
  '33',
  '37',
  '38',
  '39',
  '70',
  '76',
  '77',
  '78',
  '79',
];

export interface PlannedCustomer {
  email: string;
  fullName: string;
  phone: string;
  address: {
    recipientName: string;
    phone: string;
    addressLine1: string;
    addressLine2: string | null;
    ward: string | null;
    district: string;
    city: string;
    stateProvince: null;
    postalCode: null;
    countryCode: 'VN';
  };
}

// Distinct customers, in a fixed order for a given generator state.
export function buildCustomers(
  random: SeededRandom,
  count: number,
): PlannedCustomer[] {
  const pairs = new Set<string>();
  const customers: PlannedCustomer[] = [];
  while (customers.length < count) {
    const first = random.pick(FIRST_NAMES);
    const last = random.pick(LAST_NAMES);
    const pair = `${first}.${last}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);

    const place = random.pick(PLACES);
    const phone = `0${random.pick(MOBILE_PREFIXES)}${String(
      random.int(0, 9_999_999),
    ).padStart(7, '0')}`;
    const fullName = `${first} ${last}`;
    customers.push({
      email: `${first}.${last}@${HISTORY_EMAIL_DOMAIN}`.toLowerCase(),
      fullName,
      phone,
      address: {
        recipientName: fullName,
        phone,
        addressLine1: `${random.int(1, 320)} ${random.pick(STREETS)} Street`,
        addressLine2: random.chance(0.3)
          ? `Apartment ${random.int(1, 30)}${random.pick(['A', 'B', 'C'])}`
          : null,
        ward: `Ward ${random.int(1, 14)}`,
        district: random.pick(place.districts),
        city: place.city,
        stateProvince: null,
        postalCode: null,
        countryCode: 'VN',
      },
    });
  }
  return customers;
}
