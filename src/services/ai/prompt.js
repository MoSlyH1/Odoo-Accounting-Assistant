export function buildPrompt({ accounts = [], taxes = [], companyCurrency }) {
  // Keep the prompt lean — long lists push small free models to ramble or truncate their reply.
  const accountList = accounts.slice(0, 150).map((a) => `${a.id}|${a.code}|${a.name}`).join('\n');
  const taxList = taxes.map((t) => `${t.id}|${t.name}|${t.amount}${t.amountType === 'percent' ? '%' : ''}`).join('\n');

  return `You are an accounting assistant reading a scanned supplier document for a company in Lebanon.
The document may be in Arabic, English, French, or a mix. Read it carefully, including handwriting and stamps.

Respond with the JSON object ONLY. No reasoning, no explanation, no markdown code fences, nothing before the opening "{" or after the closing "}". Keep "account_reason" and "notes" short so the reply stays compact. Start your reply directly with "{".

The JSON object has exactly this shape:
{
  "document_type": "bill" | "refund" | "receipt" | "payment" | "other",
  "language": "ar" | "en" | "fr" | "mixed",
  "vendor": { "name": string, "name_original": string, "vat": string, "phone": string, "address": string },
  "bill_number": string,
  "date": "YYYY-MM-DD" | "",
  "due_date": "YYYY-MM-DD" | "",
  "currency": "USD" | "LBP" | "EUR" | other ISO 4217 code,
  "lines": [
    { "description": string, "quantity": number, "unit_price": number, "tax_rate": number, "account_id": number, "account_reason": string }
  ],
  "subtotal": number,
  "tax_total": number,
  "total": number,
  "tax_included_in_prices": boolean,
  "payment": { "status": "paid" | "partial" | "unpaid" | "unknown", "method": "cash" | "bank_transfer" | "card" | "cheque" | "other" | "", "amount": number, "reference": string },
  "confidence": number,
  "notes": string
}

Rules:
- vendor.name: the seller/issuer (never the buyer). Keep the name in Latin letters if it appears that way on the document; if it is only in Arabic, give a transliteration in "name" and the Arabic in "name_original".
- vendor.vat: the seller's tax/VAT/MOF number (الرقم المالي / رقم التسجيل في الضريبة) if shown, else "".
- bill_number: the invoice/receipt number (رقم الفاتورة). Not the VAT number.
- Convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) and Persian digits to Western digits. Remove thousand separators. Use "." for decimals.
- Dates in Lebanon are usually DD/MM/YYYY. Convert to YYYY-MM-DD. Empty string if absent.
- Currency: "ل.ل", "LL", "L.L", "LBP", "ليرة" mean LBP. "$", "USD", "دولار" mean USD. If both appear, use the currency of the grand total that is payable. If unclear, use "${companyCurrency || 'USD'}".
- lines: one entry per item row. unit_price is BEFORE tax unless the document only shows tax-inclusive prices (then set tax_included_in_prices true). If there are no item rows, create one line describing the purchase with the total.
- tax_rate: VAT percent for the line (Lebanon standard VAT is 11). 0 if no tax.
- document_type "refund" only for credit notes / returns (إشعار دائن / مرتجع).
- document_type "payment" for proof that money was paid to a supplier WITHOUT the goods/services listed: payment voucher (سند صرف / سند دفع), cash receipt signed by the supplier (وصل استلام / إيصال), cheque copy (شيك), bank transfer confirmation (تحويل مصرفي / SWIFT). For "payment": vendor = who received the money, total = amount paid, lines = [], bill_number = the invoice number being paid if written on it (else "").
- payment.status: "paid" when the document shows it was settled (PAID stamp, مدفوع, خالص, cash sale نقداً, card slip, "received with thanks", every "payment" document); "partial" when a deposit/advance (دفعة) is shown; "unpaid" when there are credit terms, a due date or آجل / على الحساب; otherwise "unknown".
- payment.method: "cash" (نقداً / كاش), "bank_transfer" (تحويل), "card" (بطاقة / POS slip), "cheque" (شيك), "other", or "" if not shown. payment.amount: the amount actually paid (0 if unknown). payment.reference: cheque number or transfer reference, else "".
- account_id: choose the single best expense or asset account from this list (format id|code|name). Use the id number. account_reason: under 10 words.
${accountList || '(no accounts available — use 0)'}${accounts.length > 150 ? `\n(${accounts.length - 150} more accounts exist but aren't shown — use 0 if nothing above fits)` : ''}
- Purchase taxes available (id|name|rate), for your reference:
${taxList || '(none)'}
- confidence: 0 to 1, how sure you are about the totals and vendor.
- notes: short remarks for the accountant (unclear fields, handwriting, multiple currencies). "" if none.
- The image is one bill, or one page from a stack of scanned bills. If it shows more than one separate bill, extract only the main one and say so in notes.
- If the page is not a bill at all (blank page, cover sheet, photo without amounts), set document_type "other", total 0, confidence 0, and lines [].
- Never invent values that are not on the document; use "" or 0 instead.`;
}
