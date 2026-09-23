import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select } from "radix-ui";
import { useId } from "react";

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

const currencies = currencyCodes.map((code) => ({
  code,
  label: currencyLabels[code],
  logo: `https://wise.com/public-resources/assets/flags/rectangle/${code.toLowerCase()}.png`,
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
  const selected = currencies.find((currency) => currency.code === value);
  return (
    <div className="grid gap-1 text-sm font-medium">
      <label htmlFor={id}>Currency</label>
      <Select.Root
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
      >
        <Select.Trigger
          id={id}
          className="border-input focus-visible:border-ring focus-visible:ring-ring/50 flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Select.Value>
            <span className="flex min-w-0 items-center gap-2">
              {selected && (
                <img
                  src={selected.logo}
                  alt=""
                  className="h-4 w-6 shrink-0 rounded-xs object-cover"
                />
              )}
              <span className="truncate">
                {selected ? `${selected.code} — ${selected.label}` : value}
              </span>
            </span>
          </Select.Value>
          <Select.Icon>
            <ChevronDown className="text-muted-foreground size-4 shrink-0" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="bg-popover text-popover-foreground z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] w-(--radix-select-trigger-width) overflow-hidden rounded-md border shadow-md"
          >
            <Select.ScrollUpButton className="flex h-6 items-center justify-center">
              <ChevronUp className="size-4" />
            </Select.ScrollUpButton>
            <Select.Viewport className="p-1">
              {currencies.map((currency) => (
                <Select.Item
                  key={currency.code}
                  value={currency.code}
                  textValue={`${currency.code} ${currency.label}`}
                  className="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-2 pr-8 pl-2 text-sm outline-none select-none"
                >
                  <img
                    src={currency.logo}
                    alt=""
                    className="h-4 w-6 shrink-0 rounded-xs object-cover"
                    loading="lazy"
                  />
                  <Select.ItemText>
                    {currency.code} — {currency.label}
                  </Select.ItemText>
                  <Select.ItemIndicator className="absolute right-2">
                    <Check className="size-4" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.Viewport>
            <Select.ScrollDownButton className="flex h-6 items-center justify-center">
              <ChevronDown className="size-4" />
            </Select.ScrollDownButton>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
