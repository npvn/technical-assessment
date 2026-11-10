import { isOnGrid } from '../../../src/scheduling/index.js';
import { LONDON, STEP_MINUTES, SYDNEY, at } from './fixtures.js';

describe('isOnGrid', () => {
  it('AC-15 starts on the quarter hours are on the grid', () => {
    for (const iso of [
      '2027-03-09T09:00:00Z',
      '2027-03-09T09:15:00Z',
      '2027-03-09T09:30:00Z',
      '2027-03-09T09:45:00Z',
      '2027-03-09T00:00:00Z',
    ]) {
      expect(isOnGrid(at(iso), LONDON, STEP_MINUTES)).toBe(true);
    }
  });

  it('AC-15 09:07 is off the grid', () => {
    expect(isOnGrid(at('2027-03-09T09:07:00Z'), LONDON, STEP_MINUTES)).toBe(false);
  });

  it('AC-15 09:00:30 is off the grid', () => {
    expect(isOnGrid(at('2027-03-09T09:00:30Z'), LONDON, STEP_MINUTES)).toBe(false);
  });

  it('AC-15 09:00:00.001 is off the grid', () => {
    expect(isOnGrid(at('2027-03-09T09:00:00.001Z'), LONDON, STEP_MINUTES)).toBe(false);
  });

  it('AC-15 the grid holds in BST and in Sydney', () => {
    expect(isOnGrid(at('2027-03-29T07:15:00Z'), LONDON, STEP_MINUTES)).toBe(true);
    expect(isOnGrid(at('2027-03-07T21:00:00Z'), SYDNEY, STEP_MINUTES)).toBe(true);
    expect(isOnGrid(at('2027-03-07T21:05:00Z'), SYDNEY, STEP_MINUTES)).toBe(false);
  });

  it('counts minutes in local time, not UTC', () => {
    // Every real zone offset today is a whole number of quarter hours, so a
    // 15 minute grid gives the same answer in UTC and local time. A 60 minute
    // step in India (+05:30) shows the difference: 03:30Z is 09:00 local.
    expect(isOnGrid(at('2027-03-09T03:30:00Z'), 'Asia/Kolkata', 60)).toBe(true);
    expect(isOnGrid(at('2027-03-09T03:00:00Z'), 'Asia/Kolkata', 60)).toBe(false);
  });

  it('throws on an unknown time zone', () => {
    expect(() => isOnGrid(at('2027-03-09T09:00:00Z'), 'Mars/Nowhere', STEP_MINUTES)).toThrow(
      /Mars\/Nowhere/,
    );
  });
});
