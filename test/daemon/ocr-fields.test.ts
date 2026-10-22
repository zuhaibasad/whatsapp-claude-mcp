import { describe, expect, it } from 'vitest';
import { extractOcrFields } from '../../src/daemon/ocr-fields.js';

describe('extractOcrFields', () => {
  it('reads a bank transfer receipt', () => {
    const f = extractOcrFields([
      'Meezan Bank', 'Funds Transfer Successful', 'Amount: PKR 45,000.00', 'Fee: Rs. 25',
      'Date: 20 Oct 2026 14:32', 'Transaction ID: TX88231907', 'To: Ali Traders',
    ].join('\n'));
    expect(f).toMatchObject({ amount: 'PKR 45,000.00', currency: 'PKR', date: '20 Oct 2026', reference: 'TX88231907', bank: 'Meezan' });
    expect(f.amounts).toEqual(['PKR 45,000.00', 'PKR 25']);
  });

  it('prefers the labelled total over a larger unlabelled number', () => {
    const f = extractOcrFields('Balance Rs 900,000\nTotal Rs 1,250/-');
    expect(f.amount).toBe('PKR 1,250');
  });

  it('handles amount-before-currency, slashed dates and wallet names', () => {
    const f = extractOcrFields('JazzCash\nYou sent 3,500 PKR\n21/10/2026\nTID: 0123456789');
    expect(f).toMatchObject({ amount: 'PKR 3,500', date: '21/10/2026', reference: '0123456789', bank: 'JazzCash' });
  });

  it('dollar amounts and ISO dates', () => {
    expect(extractOcrFields('Invoice paid $1,299.99 on 2026-10-01')).toMatchObject({ amount: 'USD 1,299.99', currency: 'USD', date: '2026-10-01' });
  });

  it('returns an empty object for text without fields, and ignores word-only references', () => {
    expect(extractOcrFields('Happy birthday!')).toEqual({});
    expect(extractOcrFields('Reference: pending').reference).toBeUndefined();
  });
});
