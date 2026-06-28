export function formatCurrency(value: number): string {
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} XLM`;
}

export function formatTokenBalance(valueInStroops: number, decimals: number = 7): string {
  const adjustedValue = valueInStroops / Math.pow(10, decimals);
  return formatCurrency(adjustedValue);
}
