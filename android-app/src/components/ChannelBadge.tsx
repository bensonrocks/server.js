import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { CHANNEL_COLORS, CHANNEL_LABELS } from '../theme';

export default function ChannelBadge({ channel }: { channel: string }) {
  const c = CHANNEL_COLORS[channel] || { bg: '#f1f5f9', text: '#64748b', dot: '#94a3b8' };
  return (
    <View style={[s.badge, { backgroundColor: c.bg }]}>
      <View style={[s.dot, { backgroundColor: c.dot }]} />
      <Text style={[s.label, { color: c.text }]}>{CHANNEL_LABELS[channel] || channel}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12 },
  dot:   { width: 6, height: 6, borderRadius: 3, marginRight: 5 },
  label: { fontSize: 11, fontWeight: '700' },
});
