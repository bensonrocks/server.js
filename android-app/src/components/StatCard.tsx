import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../theme';

interface Props { label: string; value: string; sub?: string; }

export default function StatCard({ label, value, sub }: Props) {
  return (
    <View style={s.card}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      {sub ? <Text style={s.sub}>{sub}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    flex: 1, backgroundColor: COLORS.surface, borderRadius: 10,
    padding: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.06,
    shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
  },
  label: { fontSize: 10, fontWeight: '700', color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  value: { fontSize: 22, fontWeight: '800', color: COLORS.text },
  sub:   { fontSize: 11, color: COLORS.muted, marginTop: 2 },
});
