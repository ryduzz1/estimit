import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import MaskedView from '@react-native-masked-view/masked-view';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Easing, Image, Linking, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import EstimitVision from './modules/estim-vision/src/EstimitVisionModule';
import { refineIdentity, requestValuation, ScanOutcome, submitScanFeedback, ValuationApiError } from './src/api';
import { formatEstimate, formatMoney, Identification, MarketEvidence, ResearchResult, ValuationResult } from './src/valuation';

type ScanState = 'ready' | 'scanning' | 'result';
type HistoryEntry = { id: string; name: string; value: string; detail: string; createdAt: string };
type SheetOutcome = ScanOutcome | { kind: 'error'; message: string };
type IdentityDraft = Pick<Identification, 'brand' | 'model' | 'variant' | 'category' | 'itemForm' | 'condition'> & { quantity: string };

const itemFormOptions: Array<{ value: Identification['itemForm']; label: string }> = [
  { value: 'single_item', label: 'ITEM' },
  { value: 'bundle', label: 'BUNDLE' },
  { value: 'accessory', label: 'ACCESSORY' },
  { value: 'replacement_part', label: 'PART' },
  { value: 'packaging', label: 'BOX' },
];
const conditionOptions: Identification['condition'][] = ['poor', 'fair', 'good', 'excellent', 'unknown'];
const HISTORY_FILE_NAME = 'estimit-history-v1.json';
const HISTORY_LIMIT = 100;
const evaluationMode = process.env.EXPO_PUBLIC_ESTIMIT_EVALUATION_MODE === 'true';

const gemMark = require('./assets/estimit-gem-mark.png');

function confidenceColor(score: number) {
  if (score >= 80) return '#85E89A';
  if (score >= 60) return '#E8D961';
  if (score >= 40) return '#FF9A5D';
  return '#FA6868';
}

function validHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return ['id', 'name', 'value', 'detail', 'createdAt'].every((key) => typeof entry[key] === 'string');
}

async function loadHistory() {
  try {
    const file = new File(Paths.document, HISTORY_FILE_NAME);
    if (!file.exists) return [];
    const parsed = JSON.parse(await file.text()) as unknown;
    return Array.isArray(parsed) ? parsed.filter(validHistoryEntry).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

async function persistHistory(entries: HistoryEntry[]) {
  try {
    const file = new File(Paths.document, HISTORY_FILE_NAME);
    if (!file.exists) file.create({ intermediates: true });
    file.write(JSON.stringify(entries.slice(0, HISTORY_LIMIT)));
  } catch {
    // A storage failure should never interrupt a scan result.
  }
}

function historyEntryFor(result: ValuationResult | ResearchResult): HistoryEntry {
  const isResearch = 'status' in result;
  const value = isResearch
    ? result.estimate ? formatMoney(result.estimate.likely, result.estimate.currency) : 'N/A'
    : formatEstimate(result);
  const count = result.evidence.length;
  return {
    id: result.id,
    name: result.item.name,
    value,
    detail: `${count} ${count === 1 ? 'listing' : 'listings'}`,
    createdAt: new Date().toISOString(),
  };
}

function historyTimestamp(createdAt: string) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanState, setScanState] = useState<ScanState>('ready');
  const [frozenImageUri, setFrozenImageUri] = useState<string | null>(null);
  const [processedImageUri, setProcessedImageUri] = useState<string | null>(null);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [outcome, setOutcome] = useState<SheetOutcome | null>(null);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [refiningIdentity, setRefiningIdentity] = useState(false);
  const [identityDraft, setIdentityDraft] = useState<IdentityDraft | null>(null);
  const [priceFeedback, setPriceFeedback] = useState<'low' | 'fair' | 'high' | null>(null);
  const [knownValueSubmitted, setKnownValueSubmitted] = useState(false);
  const { width } = useWindowDimensions();
  const cameraRef = useRef<CameraView>(null);
  const sheetProgress = useRef(new Animated.Value(0)).current;
  const sheetDrag = useRef(new Animated.Value(0)).current;
  const frozenPreviewOpacity = useRef(new Animated.Value(0)).current;
  const scanPreviewOpacity = useRef(new Animated.Value(0)).current;
  const scanIconProgress = useRef(new Animated.Value(0)).current;
  const scanDotPulses = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;
  const historyProgress = useRef(new Animated.Value(0)).current;
  const scanStateRef = useRef(scanState);
  const historyOpenRef = useRef(historyOpen);
  const followupHintsRef = useRef<string | null>(null);
  const activeHistoryIdRef = useRef<string | null>(null);
  const result = outcome?.kind === 'valuation' ? outcome.result : null;
  const identifiedResult = outcome?.kind === 'valuation' || outcome?.kind === 'research' ? outcome.result : null;

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    let active = true;
    loadHistory().then((entries) => {
      if (active) setHistoryEntries((current) => {
        if (current.length === 0) return entries;
        const currentIds = new Set(current.map((entry) => entry.id));
        return [...current, ...entries.filter((entry) => !currentIds.has(entry.id))].slice(0, HISTORY_LIMIT);
      });
    });
    return () => { active = false; };
  }, []);

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
    if (scanState !== 'scanning') {
      scanDotPulses.forEach((value) => value.setValue(0));
      return;
    }

    const animation = Animated.loop(
      Animated.stagger(135, scanDotPulses.map((value) => Animated.sequence([
        Animated.timing(value, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(value, { toValue: 0, duration: 360, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      ]))),
    );
    animation.start();
    return () => animation.stop();
  }, [scanDotPulses, scanState]);

  useEffect(() => {
    historyOpenRef.current = historyOpen;
  }, [historyOpen]);

  useEffect(() => {
    if (scanState === 'result') {
      cameraRef.current?.resumePreview().catch(() => undefined);
      sheetDrag.setValue(0);
      Animated.spring(sheetProgress, {
        toValue: 1,
        damping: 22,
        stiffness: 245,
        mass: 0.72,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        // The scan treatment is only an arrival moment; return to the live camera once the sheet lands.
        Animated.parallel([
          Animated.timing(frozenPreviewOpacity, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(scanPreviewOpacity, { toValue: 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ]).start(() => {
          setFrozenImageUri(null);
          setProcessedImageUri(null);
        });
      });
    }
  }, [frozenPreviewOpacity, scanPreviewOpacity, scanState, sheetDrag, sheetProgress]);

  const beginScan = () => {
    if (scanStateRef.current !== 'ready') return false;
    activeHistoryIdRef.current = null;
    scanStateRef.current = 'scanning';
    setScanState('scanning');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    return true;
  };

  const recordHistory = (completed: ValuationResult | ResearchResult, replaceId?: string | null) => {
    const entry = historyEntryFor(completed);
    setHistoryEntries((entries) => {
      const withoutCurrent = entries.filter((existing) => existing.id !== entry.id && (!replaceId || existing.id !== replaceId));
      const next = [entry, ...withoutCurrent].slice(0, HISTORY_LIMIT);
      void persistHistory(next);
      return next;
    });
    activeHistoryIdRef.current = entry.id;
  };

  const scanImage = async (uri: string, scanAlreadyStarted = false) => {
    if (!scanAlreadyStarted && !beginScan()) return;
    const scanStartedAt = Date.now();
    const remoteRequest = requestValuation(uri, followupHintsRef.current ?? undefined).then(
      (value) => ({ value } as const),
      (error: unknown) => ({ error } as const),
    );

    try {
      setFrozenImageUri(uri);
      setProcessedImageUri(null);
      frozenPreviewOpacity.setValue(1);
      scanPreviewOpacity.setValue(0);
      const previewSequence = await EstimitVision.processImageAsync(uri);
      const [basePreview, ...outlineFrames] = previewSequence.split('|');
      setProcessedImageUri(basePreview);
      Animated.timing(scanPreviewOpacity, {
        toValue: 1,
        duration: 150,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      for (const frame of outlineFrames) {
        await new Promise<void>((resolve) => setTimeout(resolve, 72));
        setProcessedImageUri(frame);
      }
    } catch {
      // Keep the captured image visible if the item is too ambiguous for a foreground mask.
    }

    const remainingRevealTime = Math.max(0, 1450 - (Date.now() - scanStartedAt));
    const [remote] = await Promise.all([
      remoteRequest,
      new Promise<void>((resolve) => setTimeout(resolve, remainingRevealTime)),
    ]);

    if ('error' in remote) {
      const message = remote.error instanceof ValuationApiError ? remote.error.message : 'The valuation service could not complete this scan.';
      setOutcome({ kind: 'error', message });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      setOutcome(remote.value);
      setIdentityConfirmed(false);
      setEditingIdentity(false);
      setPriceFeedback(null);
      setKnownValueSubmitted(false);
      if (remote.value.kind === 'followup') {
        const identity = remote.value.detail.identification;
        followupHintsRef.current = `Previous scan candidate: ${identity.brand} ${identity.model} ${identity.variant}. Missing details: ${identity.missingDetails.join(', ')}.`;
      } else {
        followupHintsRef.current = null;
        recordHistory(remote.value.result);
      }
      await Haptics.notificationAsync(remote.value.kind === 'valuation'
        ? Haptics.NotificationFeedbackType.Success
        : Haptics.NotificationFeedbackType.Warning);
    }

    setScanState('result');
  };

  const startScan = async () => {
    if (!permission?.granted) {
      await requestPermission();
      return;
    }
    if (!beginScan()) return;

    try {
      // With onPictureSaved, Expo resolves as soon as the frame is captured instead of
      // waiting for disk processing. Freeze the native preview at that point, then begin
      // analysis as soon as the saved file URI arrives.
      const capture = cameraRef.current?.takePictureAsync({
        quality: 0.86,
        skipProcessing: false,
        onPictureSaved: (captured) => {
          if (captured.uri) void scanImage(captured.uri, true);
        },
      });
      // iOS pauses only the preview-layer connection, not the photo output. Starting
      // capture first and pausing immediately gives an instant visual freeze while the
      // full-resolution frame continues processing in the background.
      await cameraRef.current?.pausePreview();
      await capture;
    } catch {
      scanStateRef.current = 'ready';
      setScanState('ready');
      cameraRef.current?.resumePreview().catch(() => undefined);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const choosePhoto = async () => {
    if (scanStateRef.current !== 'ready') return;
    const access = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!access.granted) return;
    const selection = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.86,
    });
    if (!selection.canceled) void scanImage(selection.assets[0].uri);
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
      frozenPreviewOpacity.setValue(0);
      scanPreviewOpacity.setValue(0);
      setOutcome(null);
      setIdentityConfirmed(false);
      setEditingIdentity(false);
      setIdentityDraft(null);
      setPriceFeedback(null);
      setKnownValueSubmitted(false);
      scanStateRef.current = 'ready';
      setScanState('ready');
    });
  };

  const dismissResult = () => {
    if (scanState === 'result') closeSheet(true);
  };

  const confirmIdentity = async () => {
    setIdentityConfirmed(true);
    setEditingIdentity(false);
    if (identifiedResult) void submitScanFeedback({ scanId: identifiedResult.id, identityVerdict: 'confirmed' }).catch(() => undefined);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const editIdentity = () => {
    if (!identifiedResult) return;
    const identity = identifiedResult.identification;
    setIdentityDraft({
      brand: identity.brand,
      model: identity.model,
      variant: identity.variant,
      category: identity.category,
      itemForm: identity.itemForm,
      condition: identity.condition,
      quantity: String(identity.quantity),
    });
    setEditingIdentity(true);
    Haptics.selectionAsync();
  };

  const applyIdentity = async () => {
    if (!identifiedResult || !identityDraft || refiningIdentity) return;
    const brand = identityDraft.brand.trim();
    const model = identityDraft.model.trim();
    const category = identityDraft.category.trim();
    if (!brand || !model || !category) {
      Alert.alert('Add the item details', 'Brand, model, and item type are needed to search accurately.');
      return;
    }
    setRefiningIdentity(true);
    try {
      const originalScanId = identifiedResult.id;
      const quantity = Math.max(1, Math.min(100, Number.parseInt(identityDraft.quantity, 10) || 1));
      const revised = await refineIdentity({
        ...identifiedResult.identification,
        ...identityDraft,
        brand,
        model,
        category,
        variant: identityDraft.variant.trim(),
        quantity,
        attributes: [],
        identifiers: [],
      });
      recordHistory(revised.result, activeHistoryIdRef.current);
      setOutcome(revised);
      setIdentityConfirmed(true);
      setEditingIdentity(false);
      setPriceFeedback(null);
      setKnownValueSubmitted(false);
      void submitScanFeedback({ scanId: originalScanId, identityVerdict: 'corrected' }).catch(() => undefined);
      void submitScanFeedback({ scanId: revised.result.id, identityVerdict: 'confirmed' }).catch(() => undefined);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Couldn’t update the match', error instanceof Error ? error.message : 'Please try again.');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setRefiningIdentity(false);
    }
  };

  const openEvidence = async (evidence: MarketEvidence) => {
    await Haptics.selectionAsync();
    try {
      await Linking.openURL(evidence.url);
    } catch {
      Alert.alert('Couldn’t open this listing', 'The marketplace link may be temporarily unavailable.');
    }
  };

  const submitPriceVerdict = async (verdict: 'low' | 'fair' | 'high') => {
    if (outcome?.kind !== 'research' || !outcome.result.estimate) return;
    setPriceFeedback(verdict);
    await Haptics.selectionAsync();
    void submitScanFeedback({ scanId: outcome.result.id, priceVerdict: verdict }).catch(() => undefined);
  };

  const promptForKnownValue = () => {
    if (!evaluationMode || Platform.OS !== 'ios' || outcome?.kind !== 'research' || !outcome.result.estimate) return;
    const estimate = outcome.result.estimate;
    const scanId = outcome.result.id;
    Alert.prompt(
      'Add a known value',
      'Enter a trusted completed-sale or market value. Estimit stores only the resulting error percentage, not this price.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Record',
          onPress: (rawValue?: string) => {
            const reference = Number((rawValue ?? '').replace(/[$,\s]/g, ''));
            if (!Number.isFinite(reference) || reference <= 0) {
              Alert.alert('Enter a valid price', 'Use a positive dollar amount.');
              return;
            }
            const relativeErrorRatio = Math.max(-10, Math.min(10, (estimate.likely - reference) / reference));
            const rangeHit = reference >= estimate.low && reference <= estimate.high;
            setKnownValueSubmitted(true);
            void submitScanFeedback({ scanId, relativeErrorRatio, rangeHit }).catch(() => undefined);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
      ],
      'plain-text',
      '',
      'decimal-pad',
    );
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
  const dotStyles = scanDotPulses.map((pulse) => ({
    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.34, 1] }),
    transform: [
      { translateY: pulse.interpolate({ inputRange: [0, 1], outputRange: [1.5, -2.5] }) },
      { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1.22] }) },
    ],
  }));
  return (
    <SafeAreaProvider>
      <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={StyleSheet.absoluteFill}>
        {permission?.granted ? <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" enableTorch={torchEnabled} /> : <CameraFallback />}
        {frozenImageUri && <Animated.Image source={{ uri: frozenImageUri }} resizeMode="cover" style={[StyleSheet.absoluteFill, { opacity: frozenPreviewOpacity }]} />}
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
        {scanState === 'ready' && (
          <View style={styles.cameraTopBar}>
            <Pressable accessibilityRole="button" accessibilityLabel="Open scan history" onPress={() => setHistoryVisible(true)} hitSlop={12} style={({ pressed }) => [styles.historyShortcut, pressed && styles.historyShortcutPressed]}>
              <Text style={styles.historyShortcutText}>History ›</Text>
            </Pressable>
          </View>
        )}
        <View style={styles.captureDock}>
          {scanState === 'scanning' && (
            <View style={styles.scanStatusPill}>
              <Text style={styles.scanStatusTitle}>Identifying item…</Text>
              <Text style={styles.scanStatusCopy}>Checking visible details and market references</Text>
            </View>
          )}
          <Pressable style={[styles.utilityButton, styles.leftUtility]} onPress={choosePhoto}>
            <Ionicons name="images-outline" color="#F5F5F7" size={20} />
          </Pressable>
          <Pressable onPressIn={startScan} onPress={startScan} disabled={scanState === 'scanning'} style={({ pressed }) => [styles.scanPressable, pressed && styles.scanPressed]}>
            <LinearGradient colors={['#3EAA5B', '#A3F39E']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.scanGradientBorder}>
              <View style={styles.scanCenter}>
                <Animated.View style={[styles.gemIcon, { opacity: gemOpacity, transform: [{ scale: gemScale }, { rotate: gemRotate }] }]}>
                  <Image source={gemMark} style={styles.gemMarkImage} />
                </Animated.View>
                <Animated.View style={[styles.scanDots, { opacity: dotsOpacity, transform: [{ translateY: dotsTranslateY }] }]}>
                  {dotStyles.map((style, index) => <Animated.View key={index} style={[styles.scanDot, style]} />)}
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

      <Animated.View style={[styles.sheet, outcome?.kind === 'followup' && styles.followupSheet, outcome?.kind === 'error' && styles.errorSheet, { transform: [{ translateY: sheetTranslation }, { scale: sheetScale }] }]} pointerEvents={scanState === 'result' ? 'auto' : 'none'}>
        <View style={styles.sheetDragArea} {...sheetPanResponder.panHandlers}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View style={styles.sheetHeaderCopy}>
              {outcome?.kind !== 'research' && <Text style={styles.kicker}>{outcome?.kind === 'valuation' ? 'EVALUATION' : outcome?.kind === 'followup' ? 'DETAIL PHOTO' : 'SCAN INTERRUPTED'}</Text>}
              <Text style={[styles.itemName, outcome?.kind === 'research' && styles.itemNameResult]}>{outcome?.kind === 'valuation' || outcome?.kind === 'research' ? outcome.result.item.name : outcome?.kind === 'followup' ? 'Add a closer photo' : 'Couldn’t send scan'}</Text>
              <Text style={styles.itemDetails} numberOfLines={2}>
                {outcome?.kind === 'valuation' || outcome?.kind === 'research'
                  ? outcome.result.item.details
                  : outcome?.kind === 'followup'
                    ? outcome.detail.requestedPhoto
                    : outcome?.kind === 'error' ? outcome.message : ''}
              </Text>
            </View>
            <Pressable style={styles.closeButton} onPress={dismissResult}><Ionicons name="close" color="#F5F5F7" size={18} /></Pressable>
          </View>
        </View>

        {identifiedResult && (
          <IdentityCheck
            identity={identifiedResult.identification}
            confirmed={identityConfirmed}
            editing={editingIdentity}
            loading={refiningIdentity}
            draft={identityDraft}
            onConfirm={confirmIdentity}
            onEdit={editIdentity}
            onCancel={() => setEditingIdentity(false)}
            onChange={setIdentityDraft}
            onApply={applyIdentity}
          />
        )}
        {result && <ValuationContent result={result} identityConfirmed={identityConfirmed} onOpenEvidence={openEvidence} />}
        {outcome?.kind === 'research' && <ResearchContent result={outcome.result} priceFeedback={priceFeedback} knownValueSubmitted={knownValueSubmitted} onKnownValue={promptForKnownValue} onPriceFeedback={submitPriceVerdict} onOpenEvidence={openEvidence} />}
        {outcome?.kind === 'followup' && <FollowupContent outcome={outcome} onContinue={() => closeSheet(true)} />}
        {outcome?.kind === 'error' && <ErrorContent onRetry={() => closeSheet(true)} />}
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
                    <Text style={styles.historyItemDetail}>{entry.detail} · {historyTimestamp(entry.createdAt)}</Text>
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

function IdentityCheck({
  identity,
  confirmed,
  editing,
  loading,
  draft,
  onConfirm,
  onEdit,
  onCancel,
  onChange,
  onApply,
}: {
  identity: Identification;
  confirmed: boolean;
  editing: boolean;
  loading: boolean;
  draft: IdentityDraft | null;
  onConfirm: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onChange: (draft: IdentityDraft) => void;
  onApply: () => void;
}) {
  if (editing && draft) {
    return (
      <View style={styles.identityEditor}>
        <View style={styles.identityEditorHeader}>
          <Text style={styles.identityTitle}>Correct the match</Text>
          <Pressable onPress={onCancel} hitSlop={10}><Text style={styles.identityTextAction}>CANCEL</Text></Pressable>
        </View>
        <View style={styles.identityFieldRow}>
          <View style={styles.identityFieldHalf}>
            <Text style={styles.identityFieldLabel}>BRAND</Text>
            <TextInput value={draft.brand} onChangeText={(brand) => onChange({ ...draft, brand })} placeholder="Brand" placeholderTextColor="#666" style={styles.identityInput} autoCapitalize="words" />
          </View>
          <View style={styles.identityFieldHalf}>
            <Text style={styles.identityFieldLabel}>ITEM TYPE</Text>
            <TextInput value={draft.category} onChangeText={(category) => onChange({ ...draft, category })} placeholder="e.g. gaming mouse" placeholderTextColor="#666" style={styles.identityInput} autoCapitalize="none" />
          </View>
        </View>
        <Text style={styles.identityFieldLabel}>MODEL</Text>
        <TextInput value={draft.model} onChangeText={(model) => onChange({ ...draft, model })} placeholder="Exact model" placeholderTextColor="#666" style={styles.identityInput} autoCapitalize="words" />
        <Text style={styles.identityFieldLabel}>VERSION / SIZE / STORAGE</Text>
        <TextInput value={draft.variant} onChangeText={(variant) => onChange({ ...draft, variant })} placeholder="Optional" placeholderTextColor="#666" style={styles.identityInput} autoCapitalize="words" />
        <View style={styles.identityChoiceRow}>
          {itemFormOptions.map((option) => (
            <Pressable key={option.value} onPress={() => onChange({ ...draft, itemForm: option.value })} style={[styles.identityChip, draft.itemForm === option.value && styles.identityChipSelected]}>
              <Text style={[styles.identityChipText, draft.itemForm === option.value && styles.identityChipTextSelected]}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.identityChoiceRow}>
          {conditionOptions.map((condition) => (
            <Pressable key={condition} onPress={() => onChange({ ...draft, condition })} style={[styles.identityChip, draft.condition === condition && styles.identityChipSelected]}>
              <Text style={[styles.identityChipText, draft.condition === condition && styles.identityChipTextSelected]}>{condition.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        {draft.itemForm === 'bundle' && (
          <View style={styles.quantityRow}>
            <Text style={styles.identityFieldLabel}>NUMBER OF ITEMS</Text>
            <TextInput value={draft.quantity} onChangeText={(quantity) => onChange({ ...draft, quantity })} keyboardType="number-pad" maxLength={3} style={[styles.identityInput, styles.quantityInput]} />
          </View>
        )}
        <Pressable disabled={loading} onPress={onApply} style={({ pressed }) => [styles.identityApply, (pressed || loading) && styles.identityApplyPressed]}>
          <Text style={styles.identityApplyText}>{loading ? 'UPDATING LISTINGS…' : 'UPDATE MATCH'}</Text>
        </Pressable>
      </View>
    );
  }

  const itemCount = identity.quantity > 1 ? `${identity.quantity} items` : null;
  return (
    <View style={[styles.identityCheck, confirmed && styles.identityCheckConfirmed]}>
      <View style={styles.identityCheckCopy}>
        <View style={styles.identityCheckLabelRow}>
          <Ionicons name={confirmed ? 'checkmark-circle' : 'help-circle-outline'} color={confirmed ? '#8CE798' : '#C4C4C4'} size={15} />
          <Text style={[styles.identityCheckLabel, confirmed && styles.identityCheckLabelConfirmed]}>{confirmed ? 'Item confirmed' : 'Is this the right item?'}</Text>
        </View>
        {itemCount && <Text numberOfLines={1} style={styles.identityCheckDetail}>{itemCount}</Text>}
      </View>
      {!confirmed && <Pressable onPress={onConfirm} style={styles.identityConfirmButton}><Text style={styles.identityConfirmText}>Yes</Text></Pressable>}
      <Pressable onPress={onEdit} style={styles.identityEditButton}><Text style={styles.identityEditText}>Edit</Text></Pressable>
    </View>
  );
}

function ValuationContent({ result, identityConfirmed, onOpenEvidence }: { result: ValuationResult; identityConfirmed: boolean; onOpenEvidence: (evidence: MarketEvidence) => void }) {
  const previewEvidence = result.disclosure?.toLowerCase().includes('preview') ?? false;
  return (
    <>
      <View style={styles.valuation}>
        <Text style={styles.kicker}>ESTIMATED RESALE VALUE</Text>
        <GradientValue value={formatEstimate(result)} />
        <View style={styles.confidenceRow}>
          <Text style={styles.confidenceLabel}>Confidence score: </Text>
          <Text style={[styles.confidenceValue, { color: confidenceColor(result.estimate.confidence) }]}>{result.estimate.confidence}%</Text>
        </View>
      </View>

      <View style={styles.hairline} />
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.sectionTitle}>{previewEvidence ? 'Market references' : 'Market evidence'}</Text>
          <Text style={[styles.proofLabel, previewEvidence && styles.previewLabel]}>
            <Ionicons name={previewEvidence ? 'flask-outline' : 'shield-checkmark'} size={11} color={previewEvidence ? '#E4CF86' : '#8CE798'} />{' '}
            {previewEvidence ? 'PREVIEW SEARCH LINKS' : 'PROOF LINKS INCLUDED'}
          </Text>
        </View>
        <Text style={styles.sectionCount}>{result.evidence.length} FOUND</Text>
      </View>
      <Text style={styles.sectionDescription}>{result.disclosure}</Text>
      <View style={styles.evidenceNote}>
        <Ionicons name="information-circle-outline" color="#A7A7A7" size={15} />
        <Text style={styles.evidenceNoteText}>
          {previewEvidence
            ? 'These are search references for product testing, not verified completed sales. Exact listing proof will replace them when providers are connected.'
            : 'Sold results support the estimate. Active listings show what sellers are asking and are context only.'}
        </Text>
      </View>

      <ScrollView style={styles.listScroll} contentContainerStyle={styles.listings} showsVerticalScrollIndicator={false}>
        {result.evidence.map((listing, index) => (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open ${listing.source} reference for ${listing.title}`}
            key={listing.id}
            onPress={() => onOpenEvidence(listing)}
            style={({ pressed }) => [styles.listingRow, pressed && styles.listingPressed]}
          >
            {listing.imageUrl ? (
              <Image source={{ uri: listing.imageUrl }} style={styles.listingImage} />
            ) : (
              <View style={[styles.listingImage, styles.listingImageFallback]}><Ionicons name="link-outline" color="#777777" size={20} /></View>
            )}
            <View style={styles.listingCopy}>
              <View style={styles.listingMeta}>
                <Text style={styles.listingSource}>{listing.source.toUpperCase()}</Text>
                <View style={[styles.evidenceBadge, listing.kind === 'sold' ? styles.soldBadge : styles.activeBadge]}>
                  <Text style={[styles.evidenceBadgeText, listing.kind === 'sold' ? styles.soldBadgeText : styles.activeBadgeText]}>{listing.kind.toUpperCase()}</Text>
                </View>
                <Text style={styles.matchScore}>{listing.matchScore}% MATCH</Text>
              </View>
              <Text numberOfLines={1} style={styles.listingTitle}>{listing.title}</Text>
              <Text numberOfLines={1} style={styles.listingDetail}>{listing.detail}</Text>
            </View>
            <View style={styles.listingAction}>
              {typeof listing.price === 'number' && <Text style={styles.listingPrice}>{formatMoney(listing.price + (listing.shipping ?? 0))}</Text>}
              <View style={styles.viewLink}><Text style={styles.viewLinkText}>VIEW</Text><Ionicons name="open-outline" color="#9DE7A2" size={12} /></View>
            </View>
            {index < result.evidence.length - 1 && <View style={styles.listingDivider} />}
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.sheetFooter}>
        <Pressable disabled={!identityConfirmed} style={[styles.saveButton, !identityConfirmed && styles.saveButtonDisabled]} onPress={() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)}>
          <Ionicons name={identityConfirmed ? 'bookmark-outline' : 'lock-closed-outline'} color={identityConfirmed ? '#F5F5F7' : '#777777'} size={17} />
          <Text style={[styles.saveLabel, !identityConfirmed && styles.saveLabelDisabled]}>{identityConfirmed ? 'SAVE TO COLLECTION' : 'CONFIRM MATCH TO SAVE'}</Text>
        </Pressable>
      </View>
    </>
  );
}

function ResearchContent({
  result,
  priceFeedback,
  knownValueSubmitted,
  onKnownValue,
  onPriceFeedback,
  onOpenEvidence,
}: {
  result: ResearchResult;
  priceFeedback: 'low' | 'fair' | 'high' | null;
  knownValueSubmitted: boolean;
  onKnownValue: () => void;
  onPriceFeedback: (verdict: 'low' | 'fair' | 'high') => void;
  onOpenEvidence: (evidence: MarketEvidence) => void;
}) {
  const estimate = result.estimate
    ? formatMoney(result.estimate.likely, result.estimate.currency)
    : 'N/A';
  return (
    <>
      <View style={styles.valuation}>
        <Text style={styles.kicker}>ESTIMATED PRICE</Text>
        <GradientValue value={estimate} muted={!result.estimate} />
        {result.estimate && <Text style={styles.marketRange}>MARKET RANGE {formatMoney(result.estimate.low, result.estimate.currency)}–{formatMoney(result.estimate.high, result.estimate.currency)}</Text>}
        {result.estimate && <Text style={styles.estimateBasis}>Based on {result.estimate.sampleSize} current listings</Text>}
        {evaluationMode && result.estimate && (
          <>
            <View style={styles.estimateFeedback}>
              <Text style={styles.estimateFeedbackLabel}>ESTIMATE</Text>
              {(['low', 'fair', 'high'] as const).map((verdict) => (
                <Pressable key={verdict} accessibilityRole="button" accessibilityState={{ selected: priceFeedback === verdict }} onPress={() => onPriceFeedback(verdict)} hitSlop={8}>
                  <Text style={[styles.estimateFeedbackOption, priceFeedback === verdict && styles.estimateFeedbackOptionSelected]}>
                    {verdict === 'low' ? 'TOO LOW' : verdict === 'fair' ? 'FAIR' : 'TOO HIGH'}
                  </Text>
                </Pressable>
              ))}
            </View>
            {evaluationMode && Platform.OS === 'ios' && (
              <Pressable onPress={onKnownValue} hitSlop={8} style={styles.knownValueButton}>
                <Text style={[styles.knownValueText, knownValueSubmitted && styles.knownValueTextSubmitted]}>{knownValueSubmitted ? 'KNOWN VALUE RECORDED' : '+ ADD KNOWN VALUE'}</Text>
              </Pressable>
            )}
          </>
        )}
      </View>
      <View style={styles.hairline} />
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Possible listings</Text>
        <Text style={styles.sectionCount}>{result.evidence.length} FOUND</Text>
      </View>
      {result.evidence.length === 0 ? (
        <View style={styles.noListings}>
          <Text style={styles.noListingsTitle}>No marketplace listings found</Text>
        </View>
      ) : <ScrollView style={styles.listScroll} contentContainerStyle={styles.listings} showsVerticalScrollIndicator={false}>
        {result.evidence.map((listing, index) => (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Open ${listing.source} search for ${listing.title}`}
            key={listing.id}
            onPress={() => onOpenEvidence(listing)}
            style={({ pressed }) => [styles.listingRow, pressed && styles.listingPressed]}
          >
            {listing.imageUrl ? (
              <Image source={{ uri: listing.imageUrl }} style={styles.listingImage} />
            ) : (
              <View style={[styles.listingImage, styles.listingImageFallback]}><Ionicons name="search-outline" color="#777777" size={20} /></View>
            )}
            <View style={styles.listingCopy}>
              <View style={styles.listingMeta}>
                <Text style={styles.listingSource}>{listing.source.toUpperCase()}</Text>
              </View>
              <Text numberOfLines={1} style={styles.listingTitle}>{listing.title}</Text>
              <Text numberOfLines={1} style={styles.listingDetail}>{listing.detail}</Text>
            </View>
            <View style={styles.listingAction}>
              {typeof listing.price === 'number' && <Text style={styles.listingPrice}>{formatMoney(listing.price + (listing.shipping ?? 0))}</Text>}
              <View style={styles.viewLink}><Text style={styles.viewLinkText}>{typeof listing.price === 'number' ? 'VIEW' : 'SEARCH'}</Text><Ionicons name="open-outline" color="#9DE7A2" size={12} /></View>
            </View>
            {index < result.evidence.length - 1 && <View style={styles.listingDivider} />}
          </Pressable>
        ))}
      </ScrollView>}
    </>
  );
}

function FollowupContent({ onContinue }: { outcome: Extract<ScanOutcome, { kind: 'followup' }>; onContinue: () => void }) {
  return (
    <View style={styles.followupActions}>
      <View style={styles.followupStatus}>
        <Ionicons name="camera-outline" color="#929292" size={15} />
        <Text style={styles.followupStatusText}>Your scan will continue from here</Text>
      </View>
      <View style={styles.followupFooter}>
        <Pressable style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]} onPress={onContinue}>
          <Ionicons name="camera-outline" color="#E1E1E1" size={17} />
          <Text style={styles.retryButtonText}>BACK TO CAMERA</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ErrorContent({ onRetry }: { onRetry: () => void }) {
  return (
    <View style={styles.errorActions}>
      <View style={styles.errorStatus}>
        <Ionicons name="shield-checkmark-outline" color="#929292" size={15} />
        <Text style={styles.errorStatusText}>No estimate was saved</Text>
      </View>
      <View style={styles.errorFooter}>
        <Pressable style={({ pressed }) => [styles.retryButton, pressed && styles.retryButtonPressed]} onPress={onRetry}>
          <Ionicons name="refresh" color="#E1E1E1" size={17} />
          <Text style={styles.retryButtonText}>TRY AGAIN</Text>
        </Pressable>
      </View>
    </View>
  );
}

function GradientValue({ value, muted = false }: { value: string; muted?: boolean }) {
  if (muted) return <View style={styles.gradientValue}><Text style={[styles.valueMask, styles.valueMuted]}>{value}</Text></View>;
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
  cameraTopBar: { height: 50, alignItems: 'flex-end', justifyContent: 'center' },
  historyShortcut: { paddingVertical: 8, paddingLeft: 12 },
  historyShortcutPressed: { opacity: 0.55 },
  historyShortcutText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', letterSpacing: -0.15 },
  captureDock: { marginTop: 'auto', position: 'relative', alignItems: 'center' },
  scanStatusPill: { position: 'absolute', bottom: 94, minWidth: 238, alignItems: 'center', paddingHorizontal: 18, paddingVertical: 11, borderRadius: 18, backgroundColor: 'rgba(8,8,8,0.88)', borderWidth: 1, borderColor: '#343434' },
  scanStatusTitle: { color: '#F5F5F7', fontSize: 13, fontWeight: '800' },
  scanStatusCopy: { color: '#969696', marginTop: 3, fontSize: 10.5, fontWeight: '500' },
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
  followupSheet: { height: 325 },
  errorSheet: { height: 305 },
  sheetDragArea: { paddingHorizontal: 20 },
  sheetHandle: { alignSelf: 'center', marginTop: 10, width: 34, height: 4, borderRadius: 3, backgroundColor: '#555555' },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingTop: 20 },
  sheetHeaderCopy: { flex: 1, paddingRight: 16 },
  kicker: { color: '#A9ADA9', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  itemName: { color: '#FFFFFF', marginTop: 6, fontSize: 29, lineHeight: 33, fontWeight: '800', letterSpacing: -1.45 },
  itemNameResult: { marginTop: 0 },
  itemDetails: { color: '#9A9A9A', marginTop: 3, fontSize: 14, fontWeight: '500' },
  closeButton: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: '#181818', borderWidth: 1, borderColor: '#363636' },
  identityCheck: { marginHorizontal: 20, marginTop: 14, minHeight: 46, paddingLeft: 13, paddingRight: 7, borderRadius: 12, borderWidth: 1, borderColor: '#3A3A3A', backgroundColor: '#171717', flexDirection: 'row', alignItems: 'center' },
  identityCheckConfirmed: { borderColor: '#315A39', backgroundColor: '#111B13' },
  identityCheckCopy: { flex: 1, paddingVertical: 8 },
  identityCheckLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  identityCheckLabel: { color: '#D2D2D2', fontSize: 12, fontWeight: '700', letterSpacing: -0.1 },
  identityCheckLabelConfirmed: { color: '#8CE798' },
  identityCheckDetail: { color: '#7F7F7F', marginTop: 2, fontSize: 10, fontWeight: '600' },
  identityConfirmButton: { height: 32, minWidth: 48, paddingHorizontal: 12, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8E8E8' },
  identityConfirmText: { color: '#111111', fontSize: 12, fontWeight: '800' },
  identityEditButton: { height: 32, minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  identityEditText: { color: '#A7A7A7', fontSize: 12, fontWeight: '700' },
  identityEditor: { marginHorizontal: 20, marginTop: 15, padding: 13, borderRadius: 15, borderWidth: 1, borderColor: '#424242', backgroundColor: '#151515' },
  identityEditorHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 },
  identityTitle: { color: '#F5F5F7', fontSize: 15, fontWeight: '800', letterSpacing: -0.25 },
  identityTextAction: { color: '#929292', fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  identityFieldRow: { flexDirection: 'row', gap: 8 },
  identityFieldHalf: { flex: 1 },
  identityFieldLabel: { color: '#858585', marginTop: 7, marginBottom: 4, fontSize: 7.5, fontWeight: '900', letterSpacing: 1 },
  identityInput: { height: 36, paddingHorizontal: 10, borderRadius: 9, borderWidth: 1, borderColor: '#393939', backgroundColor: '#0D0D0D', color: '#F5F5F7', fontSize: 12.5, fontWeight: '600' },
  identityChoiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 9 },
  identityChip: { height: 25, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1, borderColor: '#393939', backgroundColor: '#101010', alignItems: 'center', justifyContent: 'center' },
  identityChipSelected: { borderColor: '#5F9F68', backgroundColor: '#17271A' },
  identityChipText: { color: '#858585', fontSize: 7, fontWeight: '900', letterSpacing: 0.6 },
  identityChipTextSelected: { color: '#9DE7A2' },
  quantityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 5 },
  quantityInput: { width: 62, textAlign: 'center' },
  identityApply: { height: 39, marginTop: 12, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E6E6E6' },
  identityApplyPressed: { opacity: 0.66 },
  identityApplyText: { color: '#111111', fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  valuation: { paddingHorizontal: 20, paddingTop: 27 },
  gradientValue: { marginTop: 6, height: 58, alignSelf: 'stretch' },
  valueMask: { color: '#FFFFFF', fontSize: 43, lineHeight: 53, fontWeight: '800', letterSpacing: -2.1 },
  valueMuted: { color: '#777777' },
  confidenceRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  confidenceLabel: { color: '#A1A1A1', fontSize: 14, fontWeight: '600' },
  confidenceValue: { fontSize: 14, fontWeight: '800' },
  marketRange: { color: '#B8B8B8', marginTop: 2, fontSize: 11, fontWeight: '700', letterSpacing: 0.2 },
  estimateBasis: { color: '#777777', marginTop: 5, fontSize: 10.5, fontWeight: '600' },
  estimateFeedback: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 12 },
  estimateFeedbackLabel: { color: '#666666', fontSize: 7.5, fontWeight: '900', letterSpacing: 1 },
  estimateFeedbackOption: { color: '#8A8A8A', fontSize: 8, fontWeight: '900', letterSpacing: 0.75 },
  estimateFeedbackOptionSelected: { color: '#9DE7A2' },
  knownValueButton: { alignSelf: 'flex-start', marginTop: 9, paddingVertical: 2 },
  knownValueText: { color: '#686868', fontSize: 7.5, fontWeight: '900', letterSpacing: 0.8 },
  knownValueTextSubmitted: { color: '#79B981' },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: '#353535', marginHorizontal: 20, marginTop: 24 },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginHorizontal: 20, marginTop: 22 },
  sectionTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '800', letterSpacing: -0.5 },
  proofLabel: { color: '#8CE798', fontSize: 8, fontWeight: '800', letterSpacing: 1, marginTop: 4 },
  previewLabel: { color: '#E4CF86' },
  sectionCount: { color: '#A7A7A7', fontSize: 9, fontWeight: '800', letterSpacing: 1.45 },
  sectionDescription: { color: '#858585', fontSize: 11, lineHeight: 15, marginHorizontal: 20, marginTop: 5 },
  evidenceNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginHorizontal: 20, marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: '#171717', borderWidth: 1, borderColor: '#303030' },
  evidenceNoteText: { flex: 1, color: '#A7A7A7', fontSize: 10.5, lineHeight: 14 },
  listScroll: { flex: 1, marginTop: 5 },
  listings: { paddingHorizontal: 20, paddingBottom: 8 },
  noListings: { marginHorizontal: 20, marginTop: 12, paddingVertical: 18, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#303030' },
  noListingsTitle: { color: '#858585', fontSize: 12, fontWeight: '600' },
  listingRow: { minHeight: 83, paddingVertical: 10, flexDirection: 'row', alignItems: 'center' },
  listingPressed: { opacity: 0.65 },
  listingImage: { width: 55, height: 55, borderRadius: 11, borderWidth: 1, borderColor: '#454545', backgroundColor: '#1A1A1A' },
  listingImageFallback: { alignItems: 'center', justifyContent: 'center' },
  listingCopy: { flex: 1, marginLeft: 12, marginRight: 8 },
  listingMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  listingSource: { color: '#A2DFA3', fontSize: 8, fontWeight: '800', letterSpacing: 1.2 },
  evidenceBadge: { paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, borderWidth: 1 },
  soldBadge: { backgroundColor: '#142519', borderColor: '#315A39' },
  activeBadge: { backgroundColor: '#22201A', borderColor: '#5A5031' },
  evidenceBadgeText: { fontSize: 7, fontWeight: '900', letterSpacing: 0.7 },
  soldBadgeText: { color: '#8CE798' },
  activeBadgeText: { color: '#E4CF86' },
  matchScore: { color: '#777777', fontSize: 7, fontWeight: '800', letterSpacing: 0.5 },
  listingTitle: { color: '#F5F5F7', marginTop: 3, fontSize: 14, fontWeight: '700', letterSpacing: -0.3 },
  listingDetail: { color: '#8D8D8D', marginTop: 2, fontSize: 11.5, fontWeight: '500' },
  listingAction: { alignItems: 'flex-end', gap: 5 },
  listingPrice: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', letterSpacing: -0.5 },
  viewLink: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  viewLinkText: { color: '#9DE7A2', fontSize: 8, fontWeight: '900', letterSpacing: 0.8 },
  listingDivider: { position: 'absolute', left: 67, right: 0, bottom: 0, height: StyleSheet.hairlineWidth, backgroundColor: '#333333' },
  sheetFooter: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2D2D2D', backgroundColor: '#101010' },
  saveButton: { height: 49, borderRadius: 14, borderWidth: 1, borderColor: '#505050', backgroundColor: '#0B0B0B', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, shadowColor: '#000', shadowOpacity: 0.38, shadowRadius: 9, shadowOffset: { width: 0, height: 5 } },
  saveButtonDisabled: { borderColor: '#333333', backgroundColor: '#161616', shadowOpacity: 0 },
  saveLabel: { color: '#FFFFFF', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  saveLabelDisabled: { color: '#777777' },
  followupActions: { flex: 1, justifyContent: 'flex-end' },
  followupStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 20, marginBottom: 15 },
  followupStatusText: { color: '#929292', fontSize: 11.5, fontWeight: '600' },
  followupFooter: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2D2D2D' },
  errorActions: { flex: 1, justifyContent: 'flex-end' },
  errorStatus: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 20, marginBottom: 15 },
  errorStatusText: { color: '#929292', fontSize: 11.5, fontWeight: '600' },
  errorFooter: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 20, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2D2D2D' },
  retryButton: { height: 51, borderRadius: 15, borderWidth: 1, borderColor: '#606060', backgroundColor: '#242424', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  retryButtonPressed: { backgroundColor: '#303030', opacity: 0.88 },
  retryButtonText: { color: '#E8E8E8', fontSize: 10.5, fontWeight: '900', letterSpacing: 1.1 },
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
