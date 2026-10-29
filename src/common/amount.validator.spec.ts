import { validate } from 'class-validator';
import { IsAmount, isPositiveAmount } from './amount.validator';

class Dto {
  @IsAmount()
  amount!: unknown;
}

const errorsFor = async (amount: unknown): Promise<string[]> => {
  const dto = new Dto();
  dto.amount = amount;
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe('isPositiveAmount', () => {
  it.each(['1', '0.00000001', '150000.00', '12345678901234567890.12345678'])(
    'accepts %s',
    (value) => {
      expect(isPositiveAmount(value)).toBe(true);
    },
  );

  it.each([
    ['zero', '0'],
    ['zero with decimals', '0.00000000'],
    ['a JS number', 5],
    ['a negative', '-1'],
    ['a leading plus', '+1'],
    ['exponent notation', '1e3'],
    ['more than 8 dp', '1.123456789'],
    ['more than 20 integer digits', '123456789012345678901'],
    ['a trailing dot', '1.'],
    ['a leading dot', '.5'],
    ['whitespace', ' 1'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isPositiveAmount(value)).toBe(false);
  });
});

describe('@IsAmount', () => {
  it('passes a valid amount', async () => {
    expect(await errorsFor('10.5')).toEqual([]);
  });

  it('fails an invalid amount with a message naming the property', async () => {
    const messages = await errorsFor('0');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^amount must be a positive decimal string/);
  });

  it('fails a JS number rather than coercing it', async () => {
    expect(await errorsFor(10.5)).toHaveLength(1);
  });
});
