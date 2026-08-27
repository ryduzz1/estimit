import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, PanResponder, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import EstimitVision from './modules/estim-vision/src/EstimitVisionModule';

type ScanState = 'ready' | 'scanning' | 'result';
type HistoryEntry = { id: string; name: string; value: string; detail: string };

const confidence = 89;
const listingImage = 'https://images.unsplash.com/photo-1632661674596-df8be070a5c5?auto=format&fit=crop&w=240&q=80';
const gemMark = require('./assets/estimit-gem-mark.png');
const listings = [
  { source: 'Swappa', title: 'iPhone 13 Pro · 256GB', detail: 'Unlocked · Good condition', price: '$412' },
  { source: 'eBay', title: 'Apple iPhone 13 Pro', detail: 'Sierra Blue · 256GB', price: '$399' },
  { source: 'Back Market', title: 'iPhone 13 Pro Refurbished', detail: 'Excellent condition', price: '$429' },
];

function confidenceColor(score: number) {
  if (score >= 80) return '#85E89A';
  if (score >= 60) return '#E8D961';
  if (score >= 40) return '#FF9A5D';
  return '#FA6868';
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanState, setScanState] = useState<ScanState>('ready');
  const [frozenImageUri, setFrozenImageUri] = useState<string | null>(null);
  const [processedImageUri, setProcessedImageUri] = useState<string | null>(null);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const { width } = useWindowDimensions();
  const cameraRef = useRef<CameraView>(null);
  const sheetProgress = useRef(new Animated.Value(0)).current;
  const sheetDrag = useRef(new Animated.Value(0)).current;
  const scanPreviewOpacity = useRef(new Animated.Value(0)).current;
  const scanIconProgress = useRef(new Animated.Value(0)).current;
  const historyProgress = useRef(new Animated.Value(0)).current;
  const scanStateRef = useRef(scanState);
  const historyOpenRef = useRef(historyOpen);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    scanStateRef.current = scanState;
    Animated.spring(scanIconProgress, {
      toValue: scanState === 'scanning' ? 1 : 0,
      damping: 15,
      stiffness: 220,
      useNativeDriver: true,
    }).start();
  }, [scanIconProgress, scanState]);

  useEffect(() => {
    historyOpenRef.current = historyOpen;
  }, [historyOpen]);

  useEffect(() => {
    if (scanState === 'result') {
      sheetDrag.setValue(0);
      Animated.spring(sheetProgress, {
        toValue: 1,
        damping: 22,
        stiffness: 245,
        mass: 0.72,
        useNativeDriver: true,
      }).start();
    }
  }, [scanState, sheetProgress]);

  const scanImage = async (uri: string) => {
    if (scanStateRef.current !== 'ready') return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setScanState('scanning');
    const scanStartedAt = Date.now();

    try {
      setFrozenImageUri(uri);
      setProcessedImageUri(null);
      scanPreviewOpacity.setValue(0);
      const processedUri = await EstimitVision.processImageAsync(uri);
      setProcessedImageUri(processedUri);
      Animated.timing(scanPreviewOpacity, {
        toValue: 1,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } catch {
      // Keep the captured image visible if the item is too ambiguous for a foreground mask.
    }

    const remainingRevealTime = Math.max(0, 1450 - (Date.now() - scanStartedAt));
    setTimeout(async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setHistoryEntries((entries) => [
        { id: `${Date.now()}`, name: 'iPhone 13 Pro', value: '$395–$435', detail: 'Estimated just now' },
        ...entries,
      ]);
      setScanState('result');
    }, remainingRevealTime);
  };

  const startScan = async () => {
    if (!permission?.granted) {
      await requestPermission();
      return;
    }
    const captured = await cameraRef.current?.takePictureAsync({ quality: 0.86, skipProcessing: false });
    if (captured?.uri) scanImage(captured.uri);
  };

  const choosePhoto = async () => {
    if (scanStateRef.current !== 'ready') return;
    const access = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!access.granted) return;
    const selection = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.86,
    });
    if (!selection.canceled) scanImage(selection.assets[0].uri);
  };

  const toggleTorch = async () => {
    if (scanStateRef.current !== 'ready') return;
    await Haptics.selectionAsync();
    setTorchEnabled((enabled) => !enabled);
  };

  const setHistoryVisible = (visible: boolean) => {
    setHistoryOpen(visible);
    Haptics.selectionAsync();
    Animated.spring(historyProgress, {
      toValue: visible ? 1 : 0,
      damping: 24,
      stiffness: 250,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  };

  const historyPanResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 10 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderRelease: (_, gesture) => {
      if (scanStateRef.current !== 'ready') return;
      if (!historyOpenRef.current && (gesture.dx < -65 || gesture.vx < -0.55)) setHistoryVisible(true);
      if (historyOpenRef.current && (gesture.dx > 65 || gesture.vx > 0.55)) setHistoryVisible(false);
    },
  })).current;

  const closeSheet = (withHaptic = false) => {
    if (withHaptic) Haptics.selectionAsync();
    Animated.parallel([
      Animated.timing(sheetProgress, {
        toValue: 0,
        duration: 250,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(sheetDrag, {
        toValue: 0,
        duration: 250,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      setFrozenImageUri(null);
      setProcessedImageUri(null);
      scanPreviewOpacity.setValue(0);
      setScanState('ready');
    });
  };

  const dismissResult = () => {
    if (scanState === 'result') closeSheet(true);
  };

  const sheetPanResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderMove: (_, gesture) => sheetDrag.setValue(Math.max(0, gesture.dy)),
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy > 96 || gesture.vy > 0.72) {
        closeSheet(true);
        return;
      }
      Animated.spring(sheetDrag, { toValue: 0, damping: 21, stiffness: 280, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => {
      Animated.spring(sheetDrag, { toValue: 0, damping: 21, stiffness: 280, useNativeDriver: true }).start();
    },
  })).current;

  // The sheet is intentionally tall; park it beyond the full device height while idle.
  const sheetTranslateY = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [1000, 0] });
  const sheetTranslation = Animated.add(sheetTranslateY, sheetDrag);
  const sheetScale = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] });
  const backdropOpacity = sheetProgress.interpolate({ inputRange: [0, 1], outputRange: [0, 0.58] });
  const historyTranslateX = historyProgress.interpolate({ inputRange: [0, 1], outputRange: [width, 0] });
  const gemScale = scanIconProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.62] });
  const gemRotate = scanIconProgress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] });
  const gemOpacity = scanIconProgress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 0.45, 0] });
  const dotsOpacity = scanIconProgress.interpolate({ inputRange: [0, 0.45, 1], outputRange: [0, 0.2, 1] });
  const dotsTranslateY = scanIconProgress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] });
  return (
    <SafeAreaProvider>
      <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={StyleSheet.absoluteFill}>
        {permission?.granted ? <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" enableTorch={torchEnabled} /> : <CameraFallback />}
        {frozenImageUri && <Image source={{ uri: frozenImageUri }} resizeMode="cover" style={StyleSheet.absoluteFill} />}
        {processedImageUri && <Animated.Image source={{ uri: processedImageUri }} resizeMode="cover" style={[StyleSheet.absoluteFill, { opacity: scanPreviewOpacity }]} />}
        {!frozenImageUri && <View style={styles.cameraShade} />}
        <LinearGradient
          pointerEvents="none"
          colors={['transparent', 'transparent', 'rgba(0,0,0,0.48)']}
          locations={[0, 0.74, 1]}
          style={StyleSheet.absoluteFill}
        />
      </View>

      <SafeAreaView style={styles.safeArea} {...historyPanResponder.panHandlers}>
        <View style={styles.captureDock}>
          <Pressable style={[styles.utilityButton, styles.leftUtility]} onPress={choosePhoto}>
            <Ionicons name="images-outline" color="#F5F5F7" size={20} />
          </Pressable>
          <Pressable onPress={startScan} disabled={scanState === 'scanning'} style={({ pressed }) => [styles.scanPressable, pressed && styles.scanPressed]}>
            <LinearGradient colors={['#3EAA5B', '#A3F39E']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.scanGradientBorder}>
              <View style={styles.scanCenter}>
                <Animated.View style={[styles.gemIcon, { opacity: gemOpacity, transform: [{ scale: gemScale }, { rotate: gemRotate }] }]}>
                  <Image source={gemMark} style={styles.gemMarkImage} />
                </Animated.View>
                <Animated.View style={[styles.scanDots, { opacity: dotsOpacity, transform: [{ translateY: dotsTranslateY }] }]}>
                  <View style={styles.scanDot} /><View style={styles.scanDot} /><View style={styles.scanDot} />
                </Animated.View>
              </View>
            </LinearGradient>
          </Pressable>
          <Pressable style={[styles.utilityButton, styles.rightUtility, torchEnabled && styles.utilityButtonActive]} onPress={toggleTorch}>
            <Ionicons name={torchEnabled ? 'flash' : 'flash-outline'} color="#F5F5F7" size={20} />
          </Pressable>
        </View>
      </SafeAreaView>

      <Pressable style={StyleSheet.absoluteFill} onPress={dismissResult} pointerEvents={scanState === 'result' ? 'auto' : 'none'}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} />
      </Pressable>

      <Animated.View style={[styles.sheet, { transform: [{ translateY: sheetTranslation }, { scale: sheetScale }] }]} pointerEvents={scanState === 'result' ? 'auto' : 'none'}>
        <View style={styles.sheetDragArea} {...sheetPanResponder.panHandlers}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View>
              <Text style={styles.kicker}>EVALUATION</Text>
              <Text style={styles.itemName}>iPhone 13 Pro</Text>
              <Text style={styles.itemDetails}>256GB · Sierra Blue · Good condition</Text>
            </View>
            <Pressable style={styles.closeButton} onPress={dismissResult}><Ionicons name="close" color="#F5F5F7" size={18} /></Pressable>
          </View>
        </View>

        <View style={styles.valuation}>
          <Text style={styles.kicker}>ESTIMATED RESALE VALUE</Text>
          <GradientValue value="$395–$435" />
          <View style={styles.confidenceRow}>
            <Text style={styles.confidenceLabel}>Confidence score: </Text>
            <Text style={[styles.confidenceValue, { color: confidenceColor(confidence) }]}>{confidence}%</Text>
          </View>
        </View>

        <View style={styles.hairline} />
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Comparable listings</Text>
          <Text style={styles.sectionCount}>3 FOUND</Text>
        </View>
        <Text style={styles.sectionDescription}>Illustrative preview data · live sources connect in the valuation backend.</Text>

        <ScrollView style={styles.listScroll} contentContainerStyle={styles.listings} showsVerticalScrollIndicator={false}>
            {listings.map((listing, index) => (
              <Pressable key={listing.source} style={({ pressed }) => [styles.listingRow, pressed && styles.listingPressed]}>
                <Image source={{ uri: listingImage }} style={styles.listingImage} />
                <View style={styles.listingCopy}>
                  <Text style={styles.listingSource}>{listing.source.toUpperCase()}</Text>
                  <Text numberOfLines={1} style={styles.listingTitle}>{listing.title}</Text>
                  <Text style={styles.listingDetail}>{listing.detail}</Text>
                </View>
                <Text style={styles.listingPrice}>{listing.price}</Text>
                {index < listings.length - 1 && <View style={styles.listingDivider} />}
              </Pressable>
            ))}
        </ScrollView>

        <View style={styles.sheetFooter}>
          <Pressable style={styles.saveButton} onPress={() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)}>
            <Ionicons name="bookmark-outline" color="#F5F5F7" size={17} />
            <Text style={styles.saveLabel}>SAVE TO COLLECTION</Text>
          </Pressable>
        </View>
      </Animated.View>

      <Animated.View
        {...historyPanResponder.panHandlers}
        pointerEvents={historyOpen ? 'auto' : 'none'}
        style={[styles.historyPage, { transform: [{ translateX: historyTranslateX }] }]}
      >
        <SafeAreaView style={styles.historySafeArea}>
          <View style={styles.historyHeader}>
            <Text style={styles.historyTitle}>History</Text>
            <Pressable style={styles.historyBackButton} onPress={() => setHistoryVisible(false)}>
              <Ionicons name="chevron-forward" color="#F5F5F7" size={19} />
            </Pressable>
          </View>
          {historyEntries.length === 0 ? (
            <View style={styles.historyEmpty}>
              <Ionicons name="diamond-outline" color="#747474" size={30} />
              <Text style={styles.historyEmptyTitle}>No estimates yet</Text>
              <Text style={styles.historyEmptyCopy}>Completed scans will appear here.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.historyList} showsVerticalScrollIndicator={false}>
              {historyEntries.map((entry) => (
                <View key={entry.id} style={styles.historyRow}>
                  <View style={styles.historyGem}><Ionicons name="diamond" color="#F5F5F7" size={15} /></View>
                  <View style={styles.historyCopy}>
                    <Text style={styles.historyItemName}>{entry.name}</Text>
                    <Text style={styles.historyItemDetail}>{entry.detail}</Text>
                  </View>
                  <Text style={styles.historyValue}>{entry.value}</Text>
                </View>
              ))}
            </ScrollView>
          )}
        </SafeAreaView>
      </Animated.View>
      </View>
    </SafeAreaProvider>
  );
}

function GradientValue({ value }: { value: string }) {
  return (
    <MaskedView style={styles.gradientValue} maskElement={<Text style={styles.valueMask}>{value}</Text>}>
      <LinearGradient colors={['#3EAA5B', '#A3F39E']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
    </MaskedView>
  );
}

function CameraFallback() {
  return <View style={styles.cameraFallback} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#050505' },
  cameraFallback: { flex: 1, backgroundColor: '#080808' },
  cameraShade: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.08)' },
  safeArea: { flex: 1, paddingHorizontal: 20, paddingBottom: 12 },
  captureDock: { marginTop: 'auto', position: 'relative', alignItems: 'center' },
  utilityButton: { position: 'absolute', top: 23, width: 42, height: 42, borderRadius: 21, backgroundColor: '#0C0C0C', borderWidth: 1, borderColor: '#393939', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 9, shadowOffset: { width: 0, height: 4 } },
  utilityButtonActive: { backgroundColor: '#1A2C1D', borderColor: '#78C980' },
  leftUtility: { left: '22%' }, rightUtility: { right: '22%' },
  scanPressable: { width: 76, height: 76, borderRadius: 38, padding: 1.5, shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 14, shadowOffset: { width: 0, height: 7 } },
  scanPressed: { transform: [{ scale: 0.94 }] },
  scanGradientBorder: { flex: 1, padding: 1.5, borderRadius: 38 },
  scanCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 36, backgroundColor: '#0A0A0A' },
  gemIcon: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  gemMarkImage: { width: 29, height: 29, resizeMode: 'contain', tintColor: '#F5F5F7' },
  scanDots: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 4 },
  scanDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#F5F5F7' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: '#000000' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '94%', overflow: 'hidden', backgroundColor: '#101010', borderTopLeftRadius: 26, borderTopRightRadius: 26, borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#3A3A3A', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 28, shadowOffset: { width: 0, height: -10 } },
  sheetDragArea: { paddingHorizontal: 20 },
  sheetHandle: { alignSelf: 'center', marginTop: 10, width: 34, height: 4, borderRadius: 3, backgroundColor: '#555555' },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingTop: 20 },
  kicker: { color: '#A9ADA9', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  itemName: { color: '#FFFFFF', marginTop: 6, fontSize: 29, lineHeight: 33, fontWeight: '800', letterSpacing: -1.45 },
  itemDetails: { color: '#9A9A9A', marginTop: 3, fontSize: 14, fontWeight: '500' },
  closeButton: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: '#181818', borderWidth: 1, borderColor: '#363636' },
  valuation: { paddingHorizontal: 20, paddingTop: 27 },
  gradientValue: { marginTop: 6, height: 58, alignSelf: 'stretch' },
  valueMask: { color: '#FFFFFF', fontSize: 43, lineHeight: 53, fontWeight: '800', letterSpacing: -2.1 },
  confidenceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  confidenceLabel: { color: '#A1A1A1', fontSize: 14, fontWeight: '600' },
  confidenceValue: { fontSize: 14, fontWeight: '800' },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: '#353535', marginHorizontal: 20, marginTop: 24 },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginHorizontal: 20, marginTop: 22 },
  sectionTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '800', letterSpacing: -0.5 },
  sectionCount: { color: '#A7A7A7', fontSize: 9, fontWeight: '800', letterSpacing: 1.45 },
  sectionDescription: { color: '#858585', fontSize: 11, lineHeight: 15, marginHorizontal: 20, marginTop: 5 },
  listScroll: { flex: 1, marginTop: 8 },
  listings: { paddingHorizontal: 20, paddingBottom: 8 },
  listingRow: { minHeight: 83, paddingVertical: 10, flexDirection: 'row', alignItems: 'center' },
  listingPressed: { opacity: 0.65 },
  listingImage: { width: 55, height: 55, borderRadius: 11, borderWidth: 1, borderColor: '#454545', backgroundColor: '#1A1A1A' },
  listingCopy: { flex: 1, marginLeft: 12, marginRight: 8 },
  listingSource: { color: '#A2DFA3', fontSize: 8, fontWeight: '800', letterSpacing: 1.2 },
  listingTitle: { color: '#F5F5F7', marginTop: 3, fontSize: 14, fontWeight: '700', letterSpacing: -0.3 },
  listingDetail: { color: '#8D8D8D', marginTop: 2, fontSize: 11.5, fontWeight: '500' },
  listingPrice: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', letterSpacing: -0.5 },
  listingDivider: { position: 'absolute', left: 67, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: '#333333' },
  sheetFooter: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2D2D2D', backgroundColor: '#101010' },
  saveButton: { height: 49, borderRadius: 14, borderWidth: 1, borderColor: '#505050', backgroundColor: '#0B0B0B', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, shadowColor: '#000', shadowOpacity: 0.38, shadowRadius: 9, shadowOffset: { width: 0, height: 5 } },
  saveLabel: { color: '#FFFFFF', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  historyPage: { ...StyleSheet.absoluteFill, backgroundColor: '#090909' },
  historySafeArea: { flex: 1, paddingHorizontal: 20 },
  historyHeader: { height: 62, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  historyTitle: { color: '#FFFFFF', fontSize: 28, fontWeight: '800', letterSpacing: -1.1 },
  historyBackButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#353535', borderRadius: 20, backgroundColor: '#111111' },
  historyEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 74 },
  historyEmptyTitle: { color: '#F5F5F7', marginTop: 14, fontSize: 17, fontWeight: '700' },
  historyEmptyCopy: { color: '#858585', marginTop: 5, fontSize: 13 },
  historyList: { paddingTop: 12, paddingBottom: 30 },
  historyRow: { minHeight: 76, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#292929', flexDirection: 'row', alignItems: 'center' },
  historyGem: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: '#151515', borderWidth: 1, borderColor: '#363636' },
  historyCopy: { flex: 1, marginLeft: 12, marginRight: 8 },
  historyItemName: { color: '#F5F5F7', fontSize: 15, fontWeight: '700' },
  historyItemDetail: { color: '#858585', marginTop: 3, fontSize: 11 },
  historyValue: { color: '#8CE798', fontSize: 13, fontWeight: '800', letterSpacing: -0.2 },
});
