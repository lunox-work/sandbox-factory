import { useId } from "react";

import { Combobox, type ComboboxOption } from "@/components/Combobox";

const currenciesToAndFrom = [
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "JPY",
  "MYR",
  "MXN",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "TRY",
  "SEK",
  "SGD",
  "USD",
] as const;

const currenciesTo = [
  "AED",
  "ARS",
  "BDT",
  "CLP",
  "CNY",
  "COP",
  "CRC",
  "EGP",
  "GEL",
  "GHS",
  "KES",
  "KRW",
  "LKR",
  "MAD",
  "NGN",
  "NPR",
  "PKR",
  "THB",
  "TZS",
  "UAH",
  "UGX",
  "UYU",
  "VND",
  "ZAR",
] as const;

const currencyCodes = [...currenciesToAndFrom, ...currenciesTo];
type CurrencyCode = (typeof currencyCodes)[number];

const currencyLabels: Record<CurrencyCode, string> = {
  AED: "UAE Dirham",
  ARS: "Argentine Peso",
  AUD: "Australian Dollar",
  BDT: "Bangladeshi Taka",
  BRL: "Brazilian Real",
  CAD: "Canadian Dollar",
  CHF: "Swiss Franc",
  CLP: "Chilean Peso",
  CNY: "Chinese Yuan",
  COP: "Colombian Peso",
  CRC: "Costa Rican Colón",
  CZK: "Czech Koruna",
  DKK: "Danish Krone",
  EGP: "Egyptian Pound",
  EUR: "Euro",
  GBP: "British Pound",
  GEL: "Georgian Lari",
  GHS: "Ghanaian Cedi",
  HKD: "Hong Kong Dollar",
  HUF: "Hungarian Forint",
  IDR: "Indonesian Rupiah",
  ILS: "Israeli New Shekel",
  INR: "Indian Rupee",
  JPY: "Japanese Yen",
  KES: "Kenyan Shilling",
  KRW: "South Korean Won",
  LKR: "Sri Lankan Rupee",
  MAD: "Moroccan Dirham",
  MYR: "Malaysian Ringgit",
  MXN: "Mexican Peso",
  NGN: "Nigerian Naira",
  NOK: "Norwegian Krone",
  NPR: "Nepalese Rupee",
  NZD: "New Zealand Dollar",
  PHP: "Philippine Peso",
  PKR: "Pakistani Rupee",
  PLN: "Polish Złoty",
  RON: "Romanian Leu",
  SEK: "Swedish Krona",
  SGD: "Singapore Dollar",
  THB: "Thai Baht",
  TRY: "Turkish Lira",
  TZS: "Tanzanian Shilling",
  UAH: "Ukrainian Hryvnia",
  UGX: "Ugandan Shilling",
  USD: "US Dollar",
  UYU: "Uruguayan Peso",
  VND: "Vietnamese Dong",
  ZAR: "South African Rand",
};

/** A currency's flag, decorative: its code and name say which it is. */
function Flag({ code, lazy = false }: { code: string; lazy?: boolean }) {
  return (
    <img
      src={`https://wise.com/public-resources/assets/flags/rectangle/${code.toLowerCase()}.png`}
      alt=""
      className="h-4 w-6 shrink-0 rounded-xs object-cover"
      loading={lazy ? "lazy" : undefined}
    />
  );
}

const currencies: ComboboxOption[] = currencyCodes.map((code) => ({
  value: code,
  label: `${code} — ${currencyLabels[code]}`,
  icon: <Flag code={code} lazy />,
}));

export function CurrencySelect({
  value,
  onValueChange,
  disabled,
}: {
  value: string;
  onValueChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-1 text-sm font-medium">
      <label htmlFor={id}>Currency</label>
      <Combobox
        id={id}
        label="Currency"
        searchPlaceholder="Search by code or name…"
        emptyMessage="No currency matches."
        options={currencies}
        value={value}
        onValueChange={onValueChange}
        // A code the list lacks is still shown as itself.
        placeholder={value}
        disabled={disabled}
        className="font-normal"
      />
    </div>
  );
}
