import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  TouchableOpacity
} from 'react-native';
import { ApiClient } from '../api/client';

const StatsScreen = () => {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const loadStats = async () => {
    try {
      setLoading(true);
      const response = await ApiClient.getPickingStats();
      setStats(response.data);
    } catch (error) {
      Alert.alert('Error', 'Failed to load stats: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadStats();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#0066cc" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <TouchableOpacity
        style={styles.refreshButton}
        onPress={handleRefresh}
        disabled={refreshing}
      >
        <Text style={styles.refreshText}>{refreshing ? 'Refreshing...' : 'Refresh'}</Text>
      </TouchableOpacity>

      {stats && (
        <>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Warehouse Performance</Text>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Total Orders</Text>
              <Text style={styles.statValue}>{stats.totalOrders || 0}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Fulfilled</Text>
              <Text style={styles.statValue}>{stats.fulfilledOrders || 0}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Fulfillment Rate</Text>
              <Text style={styles.statValue}>{Math.round(((stats.fulfilledOrders || 0) / (stats.totalOrders || 1)) * 100)}%</Text>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Picking Performance</Text>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Items Picked Today</Text>
              <Text style={styles.statValue}>{stats.itemsPickedToday || 0}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Avg Time per Item</Text>
              <Text style={styles.statValue}>{stats.avgTimePerItem || '0'}s</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Pick Accuracy</Text>
              <Text style={styles.statValue}>{stats.pickAccuracy || 0}%</Text>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Inventory Status</Text>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Total SKUs</Text>
              <Text style={styles.statValue}>{stats.totalSkus || 0}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Low Stock Items</Text>
              <Text style={[styles.statValue, { color: stats.lowStockItems > 5 ? '#ff3333' : '#ff9900' }]}>
                {stats.lowStockItems || 0}
              </Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Out of Stock</Text>
              <Text style={[styles.statValue, { color: stats.outOfStockItems > 0 ? '#ff3333' : '#00cc00' }]}>
                {stats.outOfStockItems || 0}
              </Text>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Today's Activity</Text>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Cartons Packed</Text>
              <Text style={styles.statValue}>{stats.cartonsPacked || 0}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Orders Shipped</Text>
              <Text style={styles.statValue}>{stats.ordersShipped || 0}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Returns Processed</Text>
              <Text style={styles.statValue}>{stats.returnsProcessed || 0}</Text>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    padding: 10
  },
  refreshButton: {
    backgroundColor: '#0066cc',
    padding: 12,
    borderRadius: 5,
    marginBottom: 15,
    alignItems: 'center'
  },
  refreshText: {
    color: '#fff',
    fontWeight: 'bold'
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 15,
    marginBottom: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 3
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    paddingBottom: 10
  },
  stat: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0'
  },
  statLabel: {
    fontSize: 14,
    color: '#666'
  },
  statValue: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#0066cc'
  }
});

export default StatsScreen;
