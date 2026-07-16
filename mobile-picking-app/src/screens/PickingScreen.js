import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
  ScrollView
} from 'react-native';
import { ApiClient } from '../api/client';

const PickingScreen = () => {
  const [waves, setWaves] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedWave, setSelectedWave] = useState(null);
  const [pickItems, setPickItems] = useState([]);
  const [scannedSKU, setScannedSKU] = useState('');
  const [pickedQty, setPickedQty] = useState('');

  useEffect(() => {
    loadWaves();
    const interval = setInterval(loadWaves, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (selectedWave) {
      loadPickItems(selectedWave.id);
    }
  }, [selectedWave]);

  const loadWaves = async () => {
    try {
      setLoading(true);
      const response = await ApiClient.getPickingWaves();
      setWaves(response.data.waves || []);
    } catch (error) {
      Alert.alert('Error', 'Failed to load waves: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  const loadPickItems = async (waveId) => {
    try {
      const response = await ApiClient.getPickItems(waveId);
      setPickItems(response.data.items || []);
    } catch (error) {
      Alert.alert('Error', 'Failed to load pick items: ' + error.message);
    }
  };

  const handlePickItem = async (itemId, sku) => {
    if (!scannedSKU || !pickedQty) {
      Alert.alert('Validation', 'Please scan SKU and enter quantity');
      return;
    }

    if (scannedSKU !== sku) {
      Alert.alert('Mismatch', `SKU mismatch! Expected ${sku}, got ${scannedSKU}`);
      return;
    }

    try {
      const qty = parseInt(pickedQty);
      if (isNaN(qty) || qty <= 0) {
        Alert.alert('Invalid', 'Quantity must be > 0');
        return;
      }

      await ApiClient.markItemPicked(selectedWave.id, itemId, qty);

      setScannedSKU('');
      setPickedQty('');
      await loadPickItems(selectedWave.id);
      Alert.alert('Success', `Picked ${qty} units`);
    } catch (error) {
      Alert.alert('Error', 'Failed to record pick: ' + error.message);
    }
  };

  if (loading && waves.length === 0) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#0066cc" />
      </View>
    );
  }

  if (!selectedWave) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Active Picking Waves</Text>
        <FlatList
          data={waves.filter(w => w.status === 'picking')}
          keyExtractor={(w) => w.id}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.waveCard}
              onPress={() => setSelectedWave(item)}
            >
              <Text style={styles.waveTitle}>Wave {item.id.slice(0, 8)}</Text>
              <Text style={styles.waveInfo}>Orders: {item.ordersInWave || 0}</Text>
              <Text style={styles.waveInfo}>Progress: {Math.round((item.linesCompleted / (item.linesPerOrder * item.ordersInWave)) * 100)}%</Text>
              <Text style={styles.waveInfo}>Status: {item.status}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No active waves</Text>
          }
        />
      </View>
    );
  }

  const completedItems = pickItems.filter(i => i.qty_picked >= i.qty_required).length;
  const progressPct = Math.round((completedItems / (pickItems.length || 1)) * 100);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setSelectedWave(null)}>
          <Text style={styles.backButton}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Wave Picking</Text>
        <Text style={styles.progress}>Progress: {progressPct}%</Text>
      </View>

      <View style={styles.scanContainer}>
        <Text style={styles.label}>Scan/Enter SKU:</Text>
        <TextInput
          style={styles.input}
          placeholder="SKU or barcode"
          value={scannedSKU}
          onChangeText={setScannedSKU}
          autoFocus
        />

        <Text style={styles.label}>Quantity Picked:</Text>
        <TextInput
          style={styles.input}
          placeholder="Qty"
          keyboardType="number-pad"
          value={pickedQty}
          onChangeText={setPickedQty}
        />
      </View>

      <Text style={styles.subtitle}>Items to Pick</Text>
      <FlatList
        scrollEnabled={false}
        data={pickItems}
        keyExtractor={(i) => i.id}
        renderItem={({ item }) => (
          <View style={[styles.pickItem, item.qty_picked >= item.qty_required && styles.completedItem]}>
            <View style={styles.itemInfo}>
              <Text style={styles.sku}>{item.sku_id}</Text>
              <Text style={styles.details}>Required: {item.qty_required} | Picked: {item.qty_picked}</Text>
              <Text style={styles.location}>Bin: {item.location_bin}</Text>
            </View>
            {item.qty_picked < item.qty_required && (
              <TouchableOpacity
                style={styles.pickButton}
                onPress={() => handlePickItem(item.id, item.sku_id)}
              >
                <Text style={styles.pickButtonText}>Pick</Text>
              </TouchableOpacity>
            )}
            {item.qty_picked >= item.qty_required && (
              <Text style={styles.doneText}>✓ Done</Text>
            )}
          </View>
        )}
      />
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5'
  },
  header: {
    backgroundColor: '#0066cc',
    padding: 15,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  backButton: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold'
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold'
  },
  progress: {
    color: '#fff',
    fontSize: 14
  },
  scanContainer: {
    backgroundColor: '#fff',
    padding: 15,
    marginTop: 10
  },
  label: {
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 5
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 5,
    padding: 10,
    marginBottom: 10,
    fontSize: 14
  },
  subtitle: {
    fontSize: 16,
    fontWeight: 'bold',
    padding: 15,
    backgroundColor: '#fff',
    marginTop: 10
  },
  waveCard: {
    backgroundColor: '#fff',
    margin: 10,
    padding: 15,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#0066cc'
  },
  waveTitle: {
    fontSize: 16,
    fontWeight: 'bold'
  },
  waveInfo: {
    fontSize: 14,
    color: '#666',
    marginTop: 5
  },
  pickItem: {
    backgroundColor: '#fff',
    margin: 5,
    padding: 12,
    borderRadius: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderLeftWidth: 4,
    borderLeftColor: '#ff9900'
  },
  completedItem: {
    borderLeftColor: '#00cc00',
    opacity: 0.7
  },
  itemInfo: {
    flex: 1
  },
  sku: {
    fontSize: 14,
    fontWeight: 'bold'
  },
  details: {
    fontSize: 12,
    color: '#666',
    marginTop: 3
  },
  location: {
    fontSize: 12,
    color: '#999',
    marginTop: 2
  },
  pickButton: {
    backgroundColor: '#0066cc',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 5
  },
  pickButtonText: {
    color: '#fff',
    fontWeight: 'bold'
  },
  doneText: {
    color: '#00cc00',
    fontWeight: 'bold',
    fontSize: 16
  },
  emptyText: {
    textAlign: 'center',
    marginTop: 20,
    color: '#999'
  }
});

export default PickingScreen;
