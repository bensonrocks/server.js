import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { initBaseUrl } from './src/api';
import { COLORS } from './src/theme';

import DashboardScreen   from './src/screens/DashboardScreen';
import OrderDetailScreen from './src/screens/OrderDetailScreen';
import IngestEmailScreen from './src/screens/IngestEmailScreen';
import SettingsScreen    from './src/screens/SettingsScreen';

export type RootStackParamList = {
  Dashboard:   undefined;
  OrderDetail: { orderId: string };
  IngestEmail: undefined;
  Settings:    undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const NAV_THEME = {
  colors: {
    primary: COLORS.accent,
    background: COLORS.bg,
    card: COLORS.dark,
    text: '#ffffff',
    border: COLORS.dark,
    notification: COLORS.accent,
  },
  dark: true,
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' as const },
    medium:  { fontFamily: 'System', fontWeight: '500' as const },
    bold:    { fontFamily: 'System', fontWeight: '700' as const },
    heavy:   { fontFamily: 'System', fontWeight: '900' as const },
  },
};

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initBaseUrl().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.dark }}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={NAV_THEME}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: COLORS.dark },
            headerTintColor: '#ffffff',
            headerTitleStyle: { fontWeight: '700', fontSize: 16 },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: COLORS.bg },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen
            name="Dashboard"
            component={DashboardScreen}
            options={{ title: '📦  Order Dashboard' }}
          />
          <Stack.Screen
            name="OrderDetail"
            component={OrderDetailScreen}
            options={{ title: 'Order Details' }}
          />
          <Stack.Screen
            name="IngestEmail"
            component={IngestEmailScreen}
            options={{ title: 'Ingest Email Order' }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: 'Settings' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
