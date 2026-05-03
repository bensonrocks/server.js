import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { COLORS } from '../theme';

interface Props {
  label: string;
  active: boolean;
  onPress: () => void;
  badge?: number;
  dotColor?: string;
}

export default function FilterChip({ label, active, onPress, badge, dotColor }: Props) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[s.chip, active && s.chipActive]}
      activeOpacity={0.7}
    >
      {dotColor ? <View style={[s.dot, { backgroundColor: dotColor }]} /> : null}
      <Text style={[s.text, active && s.textActive]}>{label}</Text>
      {badge !== undefined ? (
        <View style={[s.badge, active && s.badgeActive]}>
          <Text style={[s.badgeText, active && s.badgeTextActive]}>{badge}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    borderWidth: 1.5, borderColor: COLORS.border, marginRight: 6,
    backgroundColor: COLORS.surface,
  },
  chipActive: { borderColor: COLORS.accent, backgroundColor: COLORS.accent },
  dot:  { width: 7, height: 7, borderRadius: 4 },
  text: { fontSize: 12, fontWeight: '600', color: COLORS.muted },
  textActive: { color: '#fff' },
  badge: { backgroundColor: COLORS.border, borderRadius: 10, paddingHorizontal: 5, paddingVertical: 1 },
  badgeActive: { backgroundColor: 'rgba(255,255,255,0.25)' },
  badgeText: { fontSize: 10, fontWeight: '700', color: COLORS.muted },
  badgeTextActive: { color: '#fff' },
});
