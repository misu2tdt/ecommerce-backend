import { HISTORY_EMAIL_DOMAIN, buildCustomers } from './history-people';
import { SeededRandom } from './history-random';

describe('history customers', () => {
  const customers = buildCustomers(new SeededRandom(11), 40);

  it('builds the requested number of distinct customers', () => {
    expect(customers).toHaveLength(40);
    expect(new Set(customers.map((c) => c.email)).size).toBe(40);
    expect(new Set(customers.map((c) => c.fullName)).size).toBe(40);
  });

  it('puts every email at the synthetic marker domain, which is under example.com', () => {
    expect(HISTORY_EMAIL_DOMAIN.endsWith('.example.com')).toBe(true);
    for (const customer of customers) {
      expect(customer.email).toMatch(
        new RegExp(
          `^[a-z]+\\.[a-z]+@${HISTORY_EMAIL_DOMAIN.replace(/\./g, '\\.')}$`,
        ),
      );
    }
  });

  it('is the same for the same seed', () => {
    expect(buildCustomers(new SeededRandom(11), 40)).toEqual(customers);
  });

  it('mixes Vietnamese and international names, in plain ASCII', () => {
    for (const customer of customers) {
      expect(customer.fullName).toMatch(/^[A-Za-z]+ [A-Za-z]+$/);
    }
    const lastNames = new Set(customers.map((c) => c.fullName.split(' ')[1]));
    expect(
      lastNames.has('Nguyen') || lastNames.has('Tran') || lastNames.has('Le'),
    ).toBe(true);
    expect(
      [...lastNames].some((name) =>
        [
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
        ].includes(name),
      ),
    ).toBe(true);
  });

  it('gives each a plausible Vietnamese mobile number and a complete address', () => {
    for (const customer of customers) {
      expect(customer.phone).toMatch(/^0\d{9}$/);
      expect(customer.address.phone).toBe(customer.phone);
      expect(customer.address.recipientName).toBe(customer.fullName);
      expect(customer.address.countryCode).toBe('VN');
      expect(customer.address.city.length).toBeGreaterThan(0);
      expect(customer.address.addressLine1).toMatch(/Street$/);
    }
  });
});
