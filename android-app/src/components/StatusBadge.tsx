import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { STATUS_COLORS } from '../theme';

export default function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] || { bg: '#f1f5f9', text: '#64748b' };
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <View style={[s.badge, { backgroundColor: c.bg }]}>
      <Text style={[s.text, { color: c.text }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  badge: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 12, alignSelf: 'flex-start' },
  text:  { fontSize: 11, fontWeight: '700' },
});
