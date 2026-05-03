import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, ActivityIndicator,
  StyleSheet, TouchableOpacity,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../../App';
import { api } from '../api';
import { Order } from '../types';
import { COLORS } from '../theme';
import ChannelBadge from '../components/ChannelBadge';
import StatusBadge from '../components/StatusBadge';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'OrderDetail'>;
  route: RouteProp<RootStackParamList, 'OrderDetail'>;
};

const fmt = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.sectionBody}>{children}</View>
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <View style={s.rowValue}>{children}</View>
    </View>
  );
}

function RowText({ label, value }: { label: string; value: string }) {
  return <Row label={label}><Text style={s.rowText}>{value || '—'}</Text></Row>;
}

export default function OrderDetailScreen({ route, navigation }: Props) {
  const { orderId } = route.params;
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: orderId });
    api.getOrder(orderId)
      .then(setOrder)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [orderId, navigation]);

  if (loading) {
    return <View style={s.center}><ActivityIndicator size="large" color={COLORS.accent} /></View>;
  }
  if (error || !order) {
    return (
      <View style={s.center}>
        <Text style={s.errorText}>{error || 'Order not found'}</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.backBtn}>
          <Text style={s.backBtnText}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const address = [
    order.shipping.addressLine1,
    order.shipping.addressLine2,
    order.shipping.city,
    (order.shipping.state ? order.shipping.state + ' ' : '') + order.shipping.zip,
    order.shipping.country,
  ].filter(Boolean).join(', ');

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>

      {/* Status + channel summary */}
      <View style={s.hero}>
        <View style={s.heroLeft}>
          <StatusBadge status={order.status} />
          <Text style={s.heroDate}>{fmtDate(order.orderDate)}</Text>
        </View>
        <ChannelBadge channel={order.channel} />
      </View>

      {/* Order info */}
      <Section title="Order Info">
        <RowText label="Client"   value={order.clientName} />
        <RowText label="Currency" value={order.currency} />
        <RowText label="Source"   value={order.source.type} />
        <RowText label="Ingested" value={fmtDate(order.source.ingestedAt)} />
        {order.source.emailFrom ? <RowText label="From" value={order.source.emailFrom} /> : null}
      </Section>

      {/* Items */}
      <Section title={`Items (${order.items.length})`}>
        <View style={s.itemHeader}>
          <Text style={[s.itemCol, { flex: 3 }]}>Product</Text>
          <Text style={[s.itemCol, s.itemRight]}>Qty</Text>
          <Text style={[s.itemCol, s.itemRight]}>Unit</Text>
          <Text style={[s.itemCol, s.itemRight]}>Line</Text>
        </View>
        {order.items.map((item, i) => (
          <View key={i} style={[s.itemRow, i === order.items.length - 1 && { borderBottomWidth: 0 }]}>
            <View style={{ flex: 3 }}>
              <Text style={s.itemName}>{item.name}</Text>
              <Text style={s.itemSku}>{item.sku}</Text>
            </View>
            <Text style={[s.itemCell, s.itemRight]}>{item.qty}</Text>
            <Text style={[s.itemCell, s.itemRight]}>{fmt(item.unitPrice)}</Text>
            <Text style={[s.itemCell, s.itemRight, { fontWeight: '700' }]}>{fmt(item.qty * item.unitPrice)}</Text>
          </View>
        ))}
      </Section>

      {/* Totals */}
      <Section title="Totals">
        <View style={s.totalsBox}>
          <View style={s.totalRow}><Text style={s.totalLabel}>Subtotal</Text><Text style={s.totalVal}>{fmt(order.subtotal)}</Text></View>
          <View style={s.totalRow}><Text style={s.totalLabel}>Shipping</Text><Text style={s.totalVal}>{order.shippingCost > 0 ? fmt(order.shippingCost) : 'Free'}</Text></View>
          <View style={s.totalRow}><Text style={s.totalLabel}>Tax</Text><Text style={s.totalVal}>{fmt(order.tax)}</Text></View>
          <View style={[s.totalRow, s.grandTotal]}>
            <Text style={s.grandLabel}>Total</Text>
            <Text style={s.grandVal}>{fmt(order.total)}</Text>
          </View>
        </View>
      </Section>

      {/* Shipping */}
      <Section title="Ship To">
        <RowText label="Recipient" value={order.shipping.recipient} />
        <RowText label="Address"   value={address} />
      </Section>

      {/* Notes */}
      {order.notes ? (
        <Section title="Notes">
          <View style={s.notesBox}>
            <Text style={s.notesText}>{order.notes}</Text>
          </View>
        </Section>
      ) : null}

    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  content:   { padding: 14, paddingBottom: 40 },
  center:    { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },

  hero:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: COLORS.surface, borderRadius: 12, padding: 14, marginBottom: 10, elevation: 2 },
  heroLeft:  { gap: 6 },
  heroDate:  { fontSize: 12, color: COLORS.muted, marginTop: 4 },

  section:     { backgroundColor: COLORS.surface, borderRadius: 12, marginBottom: 10, overflow: 'hidden', elevation: 2, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
  sectionTitle:{ fontSize: 10, fontWeight: '800', color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.7, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  sectionBody: { paddingHorizontal: 14, paddingVertical: 6 },

  row:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f8fafc' },
  rowLabel:  { fontSize: 13, color: COLORS.muted, flex: 1 },
  rowValue:  { flex: 2, alignItems: 'flex-end' },
  rowText:   { fontSize: 13, fontWeight: '500', color: COLORS.text, textAlign: 'right' },

  itemHeader: { flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1.5, borderBottomColor: COLORS.border },
  itemCol:    { fontSize: 11, fontWeight: '700', color: COLORS.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
  itemRight:  { flex: 1, textAlign: 'right' },
  itemRow:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f8fafc' },
  itemName:   { fontSize: 13, fontWeight: '600', color: COLORS.text },
  itemSku:    { fontSize: 11, color: COLORS.muted, fontFamily: 'monospace' },
  itemCell:   { flex: 1, fontSize: 13, color: COLORS.text },

  totalsBox:  { gap: 8, paddingVertical: 4 },
  totalRow:   { flexDirection: 'row', justifyContent: 'space-between' },
  totalLabel: { fontSize: 13, color: COLORS.muted },
  totalVal:   { fontSize: 13, color: COLORS.text },
  grandTotal: { borderTopWidth: 1.5, borderTopColor: COLORS.border, paddingTop: 10, marginTop: 4 },
  grandLabel: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  grandVal:   { fontSize: 18, fontWeight: '800', color: COLORS.text },

  notesBox:  { backgroundColor: '#fefce8', borderRadius: 8, padding: 12, borderWidth: 1, borderColor: '#fde047' },
  notesText: { fontSize: 13, color: '#713f12', lineHeight: 19 },

  errorText: { fontSize: 15, color: COLORS.danger, textAlign: 'center', marginBottom: 16 },
  backBtn:   { backgroundColor: COLORS.accent, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8 },
  backBtnText:{ color: '#fff', fontWeight: '700' },
});
