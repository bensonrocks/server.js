import React, { useEffect, useState } from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabsNavigator } from '@react-navigation/bottom-tabs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiClient } from './src/api/client';
import LoginScreen from './src/screens/LoginScreen';
import PickingScreen from './src/screens/PickingScreen';
import CartonScreen from './src/screens/CartonScreen';
import StatsScreen from './src/screens/StatsScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Tab = createBottomTabsNavigator();

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff'
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  }
});

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    checkLoginStatus();
  }, []);

  const checkLoginStatus = async () => {
    try {
      const token = await AsyncStorage.getItem('authToken');
      const userData = await AsyncStorage.getItem('user');

      if (token && userData) {
        setUser(JSON.parse(userData));
        setIsLoggedIn(true);
        ApiClient.setToken(token);
      }
    } catch (error) {
      console.error('Error checking login status:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (credentials) => {
    try {
      const response = await ApiClient.post('/api/staff/login', credentials);
      const { token, user: userData } = response.data;

      await AsyncStorage.setItem('authToken', token);
      await AsyncStorage.setItem('user', JSON.stringify(userData));

      ApiClient.setToken(token);
      setUser(userData);
      setIsLoggedIn(true);
    } catch (error) {
      throw new Error(error.response?.data?.error || 'Login failed');
    }
  };

  const handleLogout = async () => {
    try {
      await AsyncStorage.removeItem('authToken');
      await AsyncStorage.removeItem('user');
      ApiClient.setToken(null);
      setUser(null);
      setIsLoggedIn(false);
    } catch (error) {
      console.error('Error logging out:', error);
    }
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#0066cc" />
      </View>
    );
  }

  if (!isLoggedIn) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          tabBarActiveTintColor: '#0066cc',
          tabBarInactiveTintColor: '#999',
          headerShown: true,
          headerStyle: {
            backgroundColor: '#0066cc'
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: 'bold'
          }
        }}
      >
        <Tab.Screen
          name="Picking"
          component={PickingScreen}
          options={{
            title: 'Pick Orders',
            tabBarLabel: 'Picking',
            tabBarIcon: ({ color }) => <View style={{ width: 24, height: 24, backgroundColor: color }} />
          }}
        />

        <Tab.Screen
          name="Carton"
          component={CartonScreen}
          options={{
            title: 'Carton Assignment',
            tabBarLabel: 'Carton',
            tabBarIcon: ({ color }) => <View style={{ width: 24, height: 24, backgroundColor: color }} />
          }}
        />

        <Tab.Screen
          name="Stats"
          component={StatsScreen}
          options={{
            title: 'Performance',
            tabBarLabel: 'Stats',
            tabBarIcon: ({ color }) => <View style={{ width: 24, height: 24, backgroundColor: color }} />
          }}
        />

        <Tab.Screen
          name="Settings"
          component={() => <SettingsScreen user={user} onLogout={handleLogout} />}
          options={{
            title: 'Settings',
            tabBarLabel: 'Settings',
            tabBarIcon: ({ color }) => <View style={{ width: 24, height: 24, backgroundColor: color }} />
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
