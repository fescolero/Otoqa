/** Fleet map — live driver pins via dispatchMobile.listDriverLocations.
 * Centers on the FLEET's bounding box, never the user's location (D6: this
 * app holds no location permission). iOS renders on Apple Maps out of the
 * box; Android needs a Google Maps API key in app.json
 * (android.config.googleMaps.apiKey) before pins render on a real map. */
import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import MapView, { Marker } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@otoqa/convex-client';
import { useQuery } from 'convex/react';
import { colors, typography } from '../lib/theme';
import { displayLoadId } from '../lib/format';

function fleetRegion(pins: { location: { latitude: number; longitude: number } }[]) {
  const lats = pins.map((p) => p.location.latitude);
  const lngs = pins.map((p) => p.location.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.5, (maxLat - minLat) * 1.4),
    longitudeDelta: Math.max(0.5, (maxLng - minLng) * 1.4),
  };
}

export default function MapScreen() {
  const router = useRouter();
  const pins = useQuery(api.dispatchMobile.listDriverLocations, {});

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {pins === undefined ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 120 }} />
      ) : pins.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, textAlign: 'center', marginTop: 120, paddingHorizontal: 32, lineHeight: 20 }}>
          No live positions.{'\n'}Drivers appear here once they've pinged in the last 24 hours.
        </Text>
      ) : (
        <MapView style={{ flex: 1 }} initialRegion={fleetRegion(pins)}>
          {pins.map((p) => (
            <Marker
              key={p.driver._id}
              coordinate={{ latitude: p.location.latitude, longitude: p.location.longitude }}
              title={`${p.driver.firstName} ${p.driver.lastName}`}
              description={p.load ? `Load ${displayLoadId(p.load.internalId)} · ${p.load.trackingStatus}` : 'No active load'}
            />
          ))}
        </MapView>
      )}
      <Pressable
        onPress={() => router.back()}
        hitSlop={12}
        style={{ position: 'absolute', top: 58, left: 14, backgroundColor: colors.card, borderRadius: 20, padding: 8, borderWidth: 1, borderColor: colors.border }}
      >
        <Ionicons name="chevron-back" size={22} color={colors.foreground} />
      </Pressable>
    </View>
  );
}
