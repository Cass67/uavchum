package main

import (
	"math"
	"strings"
	"testing"
)

// ── WMO ───────────────────────────────────────────────────────────────────────

func TestDecodeWMO_KnownCodes(t *testing.T) {
	cases := []struct {
		code  int
		desc  string
		group string
	}{
		{0, "Clear sky", "clear"},
		{3, "Overcast", "cloud"},
		{61, "Slight rain", "rain"},
		{95, "Thunderstorm", "storm"},
		{45, "Fog", "fog"},
		{71, "Slight snow", "snow"},
	}
	for _, c := range cases {
		got := decodeWMO(c.code)
		if got.Desc != c.desc {
			t.Errorf("decodeWMO(%d).Desc = %q, want %q", c.code, got.Desc, c.desc)
		}
		if got.Group != c.group {
			t.Errorf("decodeWMO(%d).Group = %q, want %q", c.code, got.Group, c.group)
		}
		if got.Icon == "" {
			t.Errorf("decodeWMO(%d).Icon is empty", c.code)
		}
	}
}

func TestDecodeWMO_Unknown(t *testing.T) {
	got := decodeWMO(999)
	if got.Group != "unknown" {
		t.Errorf("unknown code group = %q, want unknown", got.Group)
	}
}

// ── Wind direction ────────────────────────────────────────────────────────────

func TestWindDirLabel(t *testing.T) {
	cases := []struct {
		deg  float64
		want string
	}{
		{0, "N"}, {90, "E"}, {180, "S"}, {270, "W"}, {360, "N"},
		{45, "NE"}, {135, "SE"}, {225, "SW"}, {315, "NW"},
	}
	for _, c := range cases {
		got := windDirLabel(&c.deg)
		if got != c.want {
			t.Errorf("windDirLabel(%v) = %q, want %q", c.deg, got, c.want)
		}
	}
	if windDirLabel(nil) != "VRB" {
		t.Error("windDirLabel(nil) should return VRB")
	}
}

// ── Unit conversion ───────────────────────────────────────────────────────────

func TestHpaToInhg(t *testing.T) {
	// 1013.25 hPa = 29.92 inHg (standard atmosphere)
	got := hpaToInhg(1013.25)
	if math.Abs(got-29.92) > 0.01 {
		t.Errorf("hpaToInhg(1013.25) = %.2f, want ~29.92", got)
	}
}

func TestMetersToFt(t *testing.T) {
	if metersToFt(0) != 0 {
		t.Error("metersToFt(0) should be 0")
	}
	// 1000 m ≈ 3281 ft
	got := metersToFt(1000)
	if got < 3280 || got > 3282 {
		t.Errorf("metersToFt(1000) = %d, want ~3281", got)
	}
}

// ── Input validation ──────────────────────────────────────────────────────────

func TestValidLat(t *testing.T) {
	valid := []float64{0, 90, -90, 45.5, -45.5}
	invalid := []float64{91, -91, 180, -180, 1000}
	for _, v := range valid {
		if !validLat(v) {
			t.Errorf("validLat(%v) should be true", v)
		}
	}
	for _, v := range invalid {
		if validLat(v) {
			t.Errorf("validLat(%v) should be false", v)
		}
	}
}

func TestValidLon(t *testing.T) {
	valid := []float64{0, 180, -180, 90.5, -90.5}
	invalid := []float64{181, -181, 360, -360, 1000}
	for _, v := range valid {
		if !validLon(v) {
			t.Errorf("validLon(%v) should be true", v)
		}
	}
	for _, v := range invalid {
		if validLon(v) {
			t.Errorf("validLon(%v) should be false", v)
		}
	}
}

func TestValidStation(t *testing.T) {
	valid := []string{"EGLL", "KJFK", "CYYZ", "KSFO"}
	invalid := []string{"", "E", "EG", "EGLL1", "eg ll", "!@#$"}
	for _, v := range valid {
		if !validStation(v) {
			t.Errorf("validStation(%q) should be true", v)
		}
	}
	for _, v := range invalid {
		if validStation(v) {
			t.Errorf("validStation(%q) should be false", v)
		}
	}
}

func TestValidCountry(t *testing.T) {
	if !validCountry("GB") || !validCountry("US") {
		t.Error("GB and US should be valid country codes")
	}
	for _, bad := range []string{"", "G", "GBR", "gb", "1A"} {
		if validCountry(bad) {
			t.Errorf("validCountry(%q) should be false", bad)
		}
	}
}

// ── METAR decode ──────────────────────────────────────────────────────────────

func TestDecodeMetar_Basic(t *testing.T) {
	temp := 15.0
	dewp := 8.0
	wspd := 10.0
	wgst := 18.0
	altim := 1013.2
	elev := 25.0
	lat := 51.47
	lon := -0.45

	m := metarJSON{
		RawOb:      "EGLL 121220Z 24010G18KT 9999 FEW025 15/08 Q1013",
		IcaoId:     "EGLL",
		Name:       "London Heathrow",
		FltCat:     "VFR",
		ReportTime: "2024-01-12T12:20:00Z",
		Temp:       &temp,
		Dewp:       &dewp,
		Wdir:       float64(240),
		Wspd:       &wspd,
		Wgst:       &wgst,
		Visib:      float64(9999),
		Altim:      &altim,
		Elev:       &elev,
		Lat:        &lat,
		Lon:        &lon,
	}
	d := decodeMetar(m)

	if d.Station != "EGLL" {
		t.Errorf("Station = %q, want EGLL", d.Station)
	}
	if d.FlightCat != "VFR" {
		t.Errorf("FlightCat = %q, want VFR", d.FlightCat)
	}
	if d.TempC == nil || *d.TempC != 15.0 {
		t.Errorf("TempC = %v, want 15.0", d.TempC)
	}
	if d.TempF == nil || *d.TempF != 59 {
		t.Errorf("TempF = %v, want 59", d.TempF)
	}
	if d.WindDir != "WSW" {
		t.Errorf("WindDir = %q, want WSW", d.WindDir)
	}
	if d.WindSpeedKt == nil || *d.WindSpeedKt != 10.0 {
		t.Errorf("WindSpeedKt = %v, want 10.0", d.WindSpeedKt)
	}
	if d.WindGustKt == nil || *d.WindGustKt != 18.0 {
		t.Errorf("WindGustKt = %v, want 18.0", d.WindGustKt)
	}
	if d.AltimInhg == nil || math.Abs(*d.AltimInhg-29.92) > 0.1 {
		t.Errorf("AltimInhg = %v, want ~29.92", d.AltimInhg)
	}
	if d.ElevFt == nil || *d.ElevFt < 80 || *d.ElevFt > 85 {
		t.Errorf("ElevFt = %v, want ~82", d.ElevFt)
	}
	if !strings.Contains(d.Visibility, "9999") {
		t.Errorf("Visibility = %q, expected to contain 9999", d.Visibility)
	}
}

func TestDecodeMetar_VRBWind(t *testing.T) {
	m := metarJSON{IcaoId: "XXXX", Wdir: "VRB"}
	d := decodeMetar(m)
	if d.WindDir != "VRB" {
		t.Errorf("VRB wind: WindDir = %q, want VRB", d.WindDir)
	}
}

func TestDecodeMetar_NoTemp(t *testing.T) {
	m := metarJSON{IcaoId: "XXXX"}
	d := decodeMetar(m)
	if d.TempC != nil || d.TempF != nil {
		t.Error("nil temp in input should produce nil TempC and TempF")
	}
}

// ── Civil twilight ────────────────────────────────────────────────────────────

func TestCivilTwilightUTC_LondonSummerSolstice(t *testing.T) {
	// London, ~21 June — long summer day, civil twilight expected
	dawn, dusk := civilTwilightUTC(51.5, -0.12, "2024-06-21")
	if dawn == nil || dusk == nil {
		t.Fatal("expected non-nil dawn and dusk for London in summer")
	}
	if *dawn >= *dusk {
		t.Errorf("dawn (%s) should be before dusk (%s)", *dawn, *dusk)
	}
}

func TestCivilTwilightUTC_PolarMidnight(t *testing.T) {
	// Svalbard (78°N) in December — sun never rises, twilight may not occur
	dawn, dusk := civilTwilightUTC(78.0, 15.0, "2024-12-21")
	// Either both nil (polar night) or dawn < dusk; both outcomes are valid
	if dawn != nil && dusk != nil && *dawn >= *dusk {
		t.Errorf("if twilight exists, dawn (%s) must precede dusk (%s)", *dawn, *dusk)
	}
}

func TestCivilTwilightUTC_Equator(t *testing.T) {
	// Equator — always has twilight
	dawn, dusk := civilTwilightUTC(0, 0, "2024-03-21")
	if dawn == nil || dusk == nil {
		t.Fatal("equator should always have civil twilight")
	}
	if *dawn >= *dusk {
		t.Errorf("dawn (%s) should be before dusk (%s)", *dawn, *dusk)
	}
}

// ── Drone assessment ──────────────────────────────────────────────────────────

func makeWD(windKn, gustKn, precip, temp, pressure float64, group string, cloud int) WeatherData {
	var wd WeatherData
	wd.Current.WindSpeed = windKn
	wd.Current.WindGusts = gustKn
	wd.Current.Precip = precip
	wd.Current.Temp = temp
	wd.Current.Pressure = pressure
	wd.Current.Group = group
	wd.Current.CloudCover = cloud
	return wd
}

func TestAssessDrone_GO(t *testing.T) {
	wd := makeWD(5, 8, 0, 20, 1013, "clear", 20)
	got := assessDrone(wd)
	if got.Verdict != "GO" {
		t.Errorf("expected GO, got %s (factors: %v)", got.Verdict, got.Factors)
	}
	if got.Color != "green" {
		t.Errorf("expected green, got %s", got.Color)
	}
}

func TestAssessDrone_NOGO_StrongWind(t *testing.T) {
	// 25 kn = ~46 km/h — exceeds 35 km/h danger threshold
	wd := makeWD(25, 30, 0, 20, 1013, "clear", 10)
	got := assessDrone(wd)
	if got.Verdict != "NO-GO" {
		t.Errorf("strong wind: expected NO-GO, got %s", got.Verdict)
	}
}

func TestAssessDrone_NOGO_Thunderstorm(t *testing.T) {
	wd := makeWD(5, 8, 0, 20, 1013, "storm", 90)
	got := assessDrone(wd)
	if got.Verdict != "NO-GO" {
		t.Errorf("storm: expected NO-GO, got %s", got.Verdict)
	}
}

func TestAssessDrone_NOGO_Fog(t *testing.T) {
	wd := makeWD(3, 5, 0, 15, 1013, "fog", 100)
	got := assessDrone(wd)
	if got.Verdict != "NO-GO" {
		t.Errorf("fog: expected NO-GO, got %s", got.Verdict)
	}
}

func TestAssessDrone_MARGINAL_ModerateWind(t *testing.T) {
	// 12 kn = ~22 km/h — caution band
	wd := makeWD(12, 15, 0, 20, 1013, "clear", 20)
	got := assessDrone(wd)
	if got.Verdict != "MARGINAL" {
		t.Errorf("moderate wind: expected MARGINAL, got %s", got.Verdict)
	}
}

func TestAssessDrone_NOGO_ExtremeTemp(t *testing.T) {
	wd := makeWD(5, 8, 0, -15, 1013, "clear", 10)
	got := assessDrone(wd)
	if got.Verdict != "NO-GO" {
		t.Errorf("extreme cold: expected NO-GO, got %s", got.Verdict)
	}
}

// ── Gust ratio factor ─────────────────────────────────────────────────────────

func TestGustRatioFactor_Nil_LowWind(t *testing.T) {
	// Wind < 3 kn — skip gust ratio
	if gustRatioFactor(2, 10) != nil {
		t.Error("expected nil for very low wind speed")
	}
}

func TestGustRatioFactor_Nil_LowRatio(t *testing.T) {
	if gustRatioFactor(10, 15) != nil {
		t.Error("expected nil when gust/wind ratio < 2")
	}
}

func TestGustRatioFactor_Caution(t *testing.T) {
	f := gustRatioFactor(10, 22) // ratio = 2.2x
	if f == nil {
		t.Fatal("expected non-nil factor for 2.2x ratio")
	}
	if f.Status != "caution" {
		t.Errorf("2.2x ratio: expected caution, got %s", f.Status)
	}
}

func TestGustRatioFactor_Danger(t *testing.T) {
	f := gustRatioFactor(10, 35) // ratio = 3.5x
	if f == nil {
		t.Fatal("expected non-nil factor for 3.5x ratio")
	}
	if f.Status != "danger" {
		t.Errorf("3.5x ratio: expected danger, got %s", f.Status)
	}
}

// ── Wind shear factor ─────────────────────────────────────────────────────────

func TestWindShearFactor_Nil(t *testing.T) {
	if windShearFactor(10, 15) != nil {
		t.Error("5 kn diff should return nil (below threshold)")
	}
}

func TestWindShearFactor_Caution(t *testing.T) {
	f := windShearFactor(10, 25) // diff = 15 kn
	if f == nil {
		t.Fatal("expected non-nil factor for 15 kn shear")
	}
	if f.Status != "caution" {
		t.Errorf("15 kn shear: expected caution, got %s", f.Status)
	}
}

func TestWindShearFactor_Danger(t *testing.T) {
	f := windShearFactor(10, 35) // diff = 25 kn
	if f == nil {
		t.Fatal("expected non-nil factor for 25 kn shear")
	}
	if f.Status != "danger" {
		t.Errorf("25 kn shear: expected danger, got %s", f.Status)
	}
}

// ── Hourly verdict ────────────────────────────────────────────────────────────

func TestAssessDrone_HourlyVerdicts(t *testing.T) {
	wd := makeWD(5, 8, 0, 20, 1013, "clear", 20)
	wd.Hourly = []HourlySlot{
		{Time: "2024-01-01T06:00", Wind: 5, Gusts: 8, Group: "clear", PrecipProb: 0},
		{Time: "2024-01-01T07:00", Wind: 25, Gusts: 35, Group: "clear", PrecipProb: 0},
		{Time: "2024-01-01T08:00", Wind: 5, Gusts: 8, Group: "storm", PrecipProb: 0},
	}
	got := assessDrone(wd)
	if len(got.Hourly) != 3 {
		t.Fatalf("expected 3 hourly slots, got %d", len(got.Hourly))
	}
	if got.Hourly[0].Status != "good" {
		t.Errorf("slot 0: expected good, got %s", got.Hourly[0].Status)
	}
	if got.Hourly[1].Status != "danger" {
		t.Errorf("slot 1 (strong wind): expected danger, got %s", got.Hourly[1].Status)
	}
	if got.Hourly[2].Status != "danger" {
		t.Errorf("slot 2 (storm): expected danger, got %s", got.Hourly[2].Status)
	}
}
