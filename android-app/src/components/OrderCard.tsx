import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Order } from '../types';
import { COLORS } from '../theme';
import ChannelBadge from './ChannelBadge';
import StatusBadge from './StatusBadge';

interface Props { order: Order; onPress: () => void; }

const fmt = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function OrderCard({ order, onPress }: Props) {
  return (
    <TouchableOpacity style={s.card} onPress={onPress} activeOpacity={0.7}>
      {/* Row 1: ID + date */}
      <View style={s.row}>
        <Text style={s.orderId}>{order.id}</Text>
        <Text style={s.date}>{fmtDate(order.orderDate)}</Text>
      </View>

      {/* Row 2: Client + channel */}
      <View style={[s.row, { marginTop: 6 }]}>
        <Text style={s.client} numberOfLines={1}>{order.clientName}</Text>
        <ChannelBadge channel={order.channel} />
      </View>

      {/* Row 3: items count + total + status */}
      <View style={[s.row, { marginTop: 8 }]}>
        <Text style={s.meta}>
          {order.items.length} item{order.items.length !== 1 ? 's' : ''}
          {order.items.reduce((s, i) => s + i.qty, 0) !== order.items.length
            ? ` · ${order.items.reduce((s, i) => s + i.qty, 0)} units` : ''}
        </Text>
        <View style={s.rightRow}>
          <Text style={s.total}>{fmt(order.total)}</Text>
          <StatusBadge status={order.status} />
        </View>
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface, marginHorizontal: 12, marginVertical: 5,
    borderRadius: 12, padding: 14, elevation: 2,
    shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
  },
  row:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rightRow:{ flexDirection: 'row', alignItems: 'center', gap: 8 },
  orderId: { fontFamily: 'monospace', fontSize: 13, fontWeight: '700', color: COLORS.accent },
  date:    { fontSize: 12, color: COLORS.muted },
  client:  { fontSize: 15, fontWeight: '600', color: COLORS.text, flex: 1, marginRight: 8 },
  meta:    { fontSize: 12, color: COLORS.muted },
  total:   { fontSize: 15, fontWeight: '700', color: COLORS.text },
});
