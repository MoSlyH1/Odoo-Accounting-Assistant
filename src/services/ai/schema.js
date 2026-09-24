// Strict JSON schema sent with the request ("structured outputs"). Models that support it
// (Qwen3.8 27B and Dots3 do) are constrained to return exactly this shape — no prose, no
// markdown, no half-finished objects.
const str = { type: 'string' };
const num = { type: 'number' };

export const BILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'document_type', 'language', 'vendor', 'bill_number', 'date', 'due_date', 'currency',
    'lines', 'subtotal', 'tax_total', 'total', 'tax_included_in_prices', 'payment', 'confidence', 'notes',
  ],
  properties: {
    document_type: { type: 'string', enum: ['bill', 'refund', 'receipt', 'payment', 'other'] },
    language: { type: 'string', enum: ['ar', 'en', 'fr', 'mixed'] },
    vendor: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'name_original', 'vat', 'phone', 'address'],
      properties: { name: str, name_original: str, vat: str, phone: str, address: str },
    },
    bill_number: str,
    date: str,
    due_date: str,
    currency: str,
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'quantity', 'unit_price', 'tax_rate', 'account_id', 'account_reason'],
        properties: {
          description: str,
          quantity: num,
          unit_price: num,
          tax_rate: num,
          account_id: { type: 'integer' },
          account_reason: str,
        },
      },
    },
    subtotal: num,
    tax_total: num,
    total: num,
    tax_included_in_prices: { type: 'boolean' },
    payment: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'method', 'amount', 'reference'],
      properties: {
        status: { type: 'string', enum: ['paid', 'partial', 'unpaid', 'unknown'] },
        method: { type: 'string', enum: ['cash', 'bank_transfer', 'card', 'cheque', 'other', ''] },
        amount: num,
        reference: str,
      },
    },
    confidence: num,
    notes: str,
  },
};
