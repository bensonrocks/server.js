export const COLORS = {
  dark:    '#0f172a',
  darkAlt: '#1e293b',
  accent:  '#2563eb',
  accentLight: '#dbeafe',
  bg:      '#f1f5f9',
  surface: '#ffffff',
  text:    '#0f172a',
  muted:   '#64748b',
  border:  '#e2e8f0',
  success: '#16a34a',
  danger:  '#dc2626',
};

export const CHANNEL_LABELS: Record<string, string> = {
  email:       'Email',
  shopify:     'Shopify',
  amazon:      'Amazon',
  woocommerce: 'WooCommerce',
  web:         'Web',
  instagram:   'Instagram',
};

export const CHANNEL_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  email:       { bg: '#eef2ff', text: '#4338ca', dot: '#6366f1' },
  shopify:     { bg: '#dcfce7', text: '#15803d', dot: '#22c55e' },
  amazon:      { bg: '#fff7ed', text: '#c2410c', dot: '#f97316' },
  woocommerce: { bg: '#faf5ff', text: '#7e22ce', dot: '#a855f7' },
  web:         { bg: '#e0f2fe', text: '#0369a1', dot: '#0ea5e9' },
  instagram:   { bg: '#fdf2f8', text: '#be185d', dot: '#ec4899' },
};

export const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending:    { bg: '#fef9c3', text: '#854d0e' },
  confirmed:  { bg: '#dbeafe', text: '#1e40af' },
  processing: { bg: '#ede9fe', text: '#5b21b6' },
  shipped:    { bg: '#cffafe', text: '#155e75' },
  delivered:  { bg: '#dcfce7', text: '#166534' },
  cancelled:  { bg: '#fee2e2', text: '#991b1b' },
};
