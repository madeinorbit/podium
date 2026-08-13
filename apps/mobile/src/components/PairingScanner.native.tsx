import { CameraView, type BarcodeScanningResult, useCameraPermissions } from 'expo-camera'
import { useEffect, useRef } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { PressableScale } from './PressableScale'
import { color, font, radius, sans, space } from '../theme/theme'

export function PairingScanner({
  onScanned,
  onCancel,
}: {
  onScanned(value: string): void
  onCancel(): void
}) {
  const [permission, requestPermission] = useCameraPermissions()
  const consumed = useRef(false)

  useEffect(() => {
    if (!permission) return
    if (!permission.granted && permission.canAskAgain) void requestPermission()
  }, [permission, requestPermission])

  if (!permission) return <View style={styles.root} />
  if (!permission.granted) {
    return (
      <View style={styles.permission}>
        <Text style={styles.title}>Camera access is off</Text>
        <Text style={styles.body}>
          Podium uses the camera only while this scanner is open. You can also enter the server
          address manually.
        </Text>
        {permission.canAskAgain ? (
          <PressableScale
            style={styles.button}
            onPress={() => void requestPermission()}
            accessibilityRole="button"
            accessibilityLabel="Allow camera access"
          >
            <Text style={styles.buttonText}>Allow camera</Text>
          </PressableScale>
        ) : (
          <PressableScale
            style={styles.button}
            onPress={() => void Linking.openSettings()}
            accessibilityRole="button"
            accessibilityLabel="Open system settings"
          >
            <Text style={styles.buttonText}>Open Settings</Text>
          </PressableScale>
        )}
        <PressableScale
          style={styles.secondary}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Return to server setup"
        >
          <Text style={styles.secondaryText}>Back</Text>
        </PressableScale>
      </View>
    )
  }

  const handle = (result: BarcodeScanningResult) => {
    if (consumed.current) return
    consumed.current = true
    onScanned(result.data)
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={handle}
      />
      <View style={styles.scrim} pointerEvents="none">
        <View style={styles.finder} />
        <Text style={styles.help}>Point at the code shown in Podium</Text>
      </View>
      <PressableScale style={styles.cancel} onPress={onCancel} accessibilityRole="button">
        <Text style={styles.cancelText}>Cancel</Text>
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050507' },
  scrim: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  finder: { width: 250, height: 250, borderWidth: 3, borderColor: '#fff', borderRadius: radius.lg },
  help: { color: '#fff', ...sans(600), fontSize: font.body },
  cancel: {
    position: 'absolute',
    top: 58,
    left: 20,
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 22,
    backgroundColor: '#000b',
    justifyContent: 'center',
  },
  cancelText: { color: '#fff', ...sans(600), fontSize: font.body },
  permission: {
    flex: 1,
    backgroundColor: color.bg,
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  title: { color: color.text, ...sans(700), fontSize: font.title },
  body: { color: color.textDim, fontSize: font.body, lineHeight: 23 },
  button: {
    minHeight: 48,
    borderRadius: radius.sm,
    backgroundColor: color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: color.accentText, ...sans(700), fontSize: font.body },
  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: color.textDim, ...sans(600), fontSize: font.body },
})
