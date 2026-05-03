import React, { useState, useCallback, useLayoutEffect, useEffect, useRef } from 'react';
import {
  View, Text, FlatList, TextInput, ScrollView,
  TouchableOpacity, RefreshControl, ActivityIndicator,
  StyleSheet, StatusBar,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import { api } from '../api';
import { Order, Stats, Client, Channel } from '../types';
import { COLORS, CHANNEL_COLORS, CHANNEL_LABELS } from '../theme';
import StatCard from '../components/StatCard';
import OrderCard from '../components/OrderCard';
import FilterChip from '../components/FilterChip';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Dashboard'> };

const STATUSES = ['', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
const STATUS_LABELS: Record<string, string> = {
  '': 'All', pending: 'Pending', confirmed: 'Confirmed',
  processing: 'Processing', shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled',
};

export default function DashboardScreen({ navigation }: Props) {
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [orders, setOrders]           = useState<Order[]>([]);
  const [stats, setStats]             = useState<Stats | null>(null);
  const [clients, setClients]         = useState<Client[]>([]);
  const [channels, setChannels]       = useState<Channel[]>([]);
  const [activeClient, setActiveClient]   = useState<string | null>(null);
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  const [activeStatus, setActiveStatus]   = useState('');
  const [searchText, setSearchText]       = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const firstLoad = useRef(true);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchText), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={s.headerActions}>
          <TouchableOpacity onPress={() => navigation.navigate('IngestEmail')} style={s.headerBtn}>
            <Text style={s.headerBtnIcon}>✉️</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={s.headerBtn}>
            <Text style={s.headerBtnIcon}>⚙️</Text>
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation]);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      if (activeClient) params.clientId = activeClient;
      if (activeChannel) params.channel = activeChannel;
      if (activeStatus) params.status = activeStatus;
      if (debouncedSearch) params.search = debouncedSearch;

      const [ordersRes, statsRes, clientsRes, channelsRes] = await Promise.all([
        api.getOrders(params),
        api.getStats(),
        api.getClients(),
        api.getChannels(),
      ]);
      setOrders(ordersRes);
      setStats(statsRes);
      setClients(clientsRes);
      setChannels(channelsRes);
    } catch (e: any) {
      setError(e.message || 'Could not connect to server');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeClient, activeChannel, activeStatus, debouncedSearch]);

  // Reload when filters change (skip very first render — useFocusEffect handles that)
  useEffect(() => {
    if (firstLoad.current) { firstLoad.current = false; return; }
    load();
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color={COLORS.accent} />
        <Text style={s.loadingText}>Loading orders…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={s.center}>
        <Text style={s.errorIcon}>📡</Text>
        <Text style={s.errorTitle}>Connection failed</Text>
        <Text style={s.errorMsg}>{error}</Text>
        <TouchableOpacity style={s.retryBtn} onPress={() => { setLoading(true); load(); }}>
          <Text style={s.retryBtnText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
          <Text style={s.settingsLink}>Check server settings →</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.dark} />

      {/* Stats row */}
      {stats && (
        <View style={s.statsRow}>
          <StatCard label="Orders"   value={String(stats.totalOrders)} />
          <StatCard label="Revenue"  value={`$${(stats.totalRevenue / 1000).toFixed(1)}k`} />
          <StatCard label="Clients"  value={String(stats.totalClients)} />
          <StatCard label="Channels" value={String(stats.totalChannels)} />
        </View>
      )}

      {/* Search */}
      <View style={s.searchWrap}>
        <TextInput
          style={s.searchInput}
          placeholder="Search orders, clients…"
          placeholderTextColor={COLORS.muted}
          value={searchText}
          onChangeText={setSearchText}
          returnKeyType="search"
        />
      </View>

      {/* Client chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        style={s.chipScroll} contentContainerStyle={s.chipContent}>
        <FilterChip label="All Clients" active={!activeClient} onPress={() => setActiveClient(null)} />
        {clients.map(c => (
          <FilterChip key={c.id} label={c.name} badge={c.orderCount}
            active={activeClient === c.id}
            onPress={() => setActiveClient(activeClient === c.id ? null : c.id)} />
        ))}
      </ScrollView>

      {/* Channel chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        style={s.chipScroll} contentContainerStyle={s.chipContent}>
        <FilterChip label="All Channels" active={!activeChannel} onPress={() => setActiveChannel(null)} />
        {channels.map(c => (
          <FilterChip key={c.channel}
            label={CHANNEL_LABELS[c.channel] || c.channel}
            badge={c.count}
            dotColor={(CHANNEL_COLORS[c.channel] || {}).dot}
            active={activeChannel === c.channel}
            onPress={() => setActiveChannel(activeChannel === c.channel ? null : c.channel)} />
        ))}
      </ScrollView>

      {/* Status chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        style={[s.chipScroll, { marginBottom: 4 }]} contentContainerStyle={s.chipContent}>
        {STATUSES.map(st => (
          <FilterChip key={st || 'all'} label={STATUS_LABELS[st]}
            active={activeStatus === st} onPress={() => setActiveStatus(st)} />
        ))}
      </ScrollView>

      {/* Order list */}
      <FlatList
        data={orders}
        keyExtractor={o => o.id}
        renderItem={({ item }) => (
          <OrderCard order={item}
            onPress={() => navigation.navigate('OrderDetail', { orderId: item.id })} />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)}
            colors={[COLORS.accent]} tintColor={COLORS.accent} />
        }
        contentContainerStyle={orders.length === 0 ? s.emptyContainer : { paddingBottom: 20 }}
        ListEmptyComponent={
          <View style={s.emptyState}>
            <Text style={s.emptyIcon}>📭</Text>
            <Text style={s.emptyText}>No orders match your filters</Text>
          </View>
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  center:    { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: COLORS.bg },

  headerActions: { flexDirection: 'row', gap: 4 },
  headerBtn:     { padding: 6 },
  headerBtnIcon: { fontSize: 20 },

  statsRow: { flexDirection: 'row', gap: 8, margin: 12 },

  searchWrap:  { marginHorizontal: 12, marginBottom: 8 },
  searchInput: {
    backgroundColor: COLORS.surface, borderRadius: 10, paddingHorizontal: 14,
    paddingVertical: 10, fontSize: 14, color: COLORS.text,
    borderWidth: 1.5, borderColor: COLORS.border, elevation: 1,
  },

  chipScroll:  { flexGrow: 0, marginBottom: 2 },
  chipContent: { paddingHorizontal: 12, paddingVertical: 4 },

  emptyContainer: { flex: 1 },
  emptyState:  { alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  emptyIcon:   { fontSize: 48, marginBottom: 12 },
  emptyText:   { fontSize: 15, color: COLORS.muted },

  loadingText: { marginTop: 12, fontSize: 14, color: COLORS.muted },
  errorIcon:   { fontSize: 48, marginBottom: 12 },
  errorTitle:  { fontSize: 18, fontWeight: '700', color: COLORS.text, marginBottom: 6 },
  errorMsg:    { fontSize: 13, color: COLORS.muted, textAlign: 'center', marginBottom: 20, paddingHorizontal: 20 },
  retryBtn:    { backgroundColor: COLORS.accent, paddingHorizontal: 28, paddingVertical: 11, borderRadius: 8, marginBottom: 12 },
  retryBtnText:{ color: '#fff', fontWeight: '700', fontSize: 14 },
  settingsLink:{ color: COLORS.accent, fontSize: 13 },
});
