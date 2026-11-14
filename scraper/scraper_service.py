from flask import Flask, request, jsonify
from flask_cors import CORS
import requests, random, re, time, base64
from bs4 import BeautifulSoup
from urllib.parse import urlparse
from datetime import datetime, timedelta

# Optional Selenium
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options as ChromeOptions
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException, WebDriverException
    SELENIUM_AVAILABLE = True
except ImportError:
    SELENIUM_AVAILABLE = False

app = Flask(__name__)
CORS(app)

def detect_platform(url):
    d = urlparse(url).netloc.lower()
    if 'amazon' in d: return 'Amazon'
    if 'flipkart' in d: return 'Flipkart'
    if 'jharkhand-ecom' in d: return 'JharkhandEcom'
    if 'elegantdream' in d: return 'ElegantDream'
    return 'Generic'

def extract_price(text):
    if not text: return None
    # Remove currency symbols and commas, but keep decimal point
    # We want to match numbers like 1,299.00 -> 1299.00
    clean_text = re.sub(r'[^\d.]', '', text.replace(',', ''))
    try:
        return float(clean_text)
    except:
        # Try a more aggressive search if direct float fails
        match = re.search(r'[\d,]+\.?\d*', text.replace(',', ''))
        if match:
            try: return float(match.group().replace(',', ''))
            except: return None
    return None

def parse_html(soup, platform):
    title, price, currency, image, description, features = None, None, None, None, None, []

    if platform == "Amazon":
        title_tag = soup.find("span", id="productTitle") or soup.find("h1")
        if title_tag: title = title_tag.get_text(strip=True)
        
        price_tag = soup.find("span", class_="a-price-whole") or soup.find("span", id="priceblock_ourprice")
        if price_tag: price = extract_price(price_tag.get_text())
        
        img = soup.find("img", id="landingImage") or soup.find("img", class_="a-dynamic-image")
        image = img.get("src") if img else None
        
        desc_tag = soup.find("div", id="productDescription") or soup.find("div", id="feature-bullets")
        if desc_tag: description = desc_tag.get_text(strip=True)
        
        feature_tags = soup.find_all("li", class_="a-spacing-mini")
        features = [f.get_text(strip=True) for f in feature_tags if f.get_text(strip=True)]

    elif platform == "Flipkart":
        title_tag = soup.find("span", class_="B_NuCI") or soup.find("h1")
        if title_tag: title = title_tag.get_text(strip=True)
        
        price_tag = soup.find("div", class_="_30jeq3") or soup.find("div", class_="_16Jk6d")
        if price_tag: price = extract_price(price_tag.get_text())
        
        img = soup.find("img", class_="_396cs4")
        image = img.get("src") if img else None
        
        desc_tag = soup.find("div", class_="_1mXo9B") or soup.find("div", class_="R__S1C")
        if desc_tag: description = desc_tag.get_text(strip=True)
        
        feature_tags = soup.find_all("li", class_="_21l9_M")
        features = [f.get_text(strip=True) for f in feature_tags if f.get_text(strip=True)]

    elif platform in ["JharkhandEcom", "ElegantDream", "Generic"]:
        title_tag = soup.find("h1") or soup.find("h2")
        if title_tag: title = title_tag.get_text(strip=True)
        
        # Specific selectors for JharkhandEcom/Lumina
        price_tag = soup.find(class_=re.compile(r'price', re.I)) or soup.find("span", class_="price")
        if price_tag:
            price = extract_price(price_tag.get_text())
            currency_text = price_tag.get_text()
            if '$' in currency_text or 'USD' in currency_text:
                currency = "USD"
            elif '₹' in currency_text or 'INR' in currency_text:
                currency = "INR"

        if not price:
            # Fallback to regex search in the whole text
            text = soup.get_text()
            # Support for $, ₹, Rs, INR, USD
            price_match = re.search(r"(?:\$|₹|Rs\.?|INR|USD)\s*([\d,]+(?:\.\d+)?)", text)
            if price_match:
                price = extract_price(price_match.group(1))
                if '$' in price_match.group(0) or 'USD' in price_match.group(0):
                    currency = "USD"
        
        img = soup.find("img", class_=re.compile(r'product|main', re.I)) or soup.find("img")
        image = img.get("src") if img else None
        
        # Generic description extraction
        desc_tag = soup.find(class_=re.compile(r'description|content|about', re.I)) or soup.find("p")
        if desc_tag: description = desc_tag.get_text(strip=True)
        
        # Generic features extraction
        feature_list = soup.find("ul")
        if feature_list:
            features = [li.get_text(strip=True) for li in feature_list.find_all("li")[:10]]

    if title and price:
        return {
            "success": True,
            "title": title[:200],
            "price": price,
            "currency": currency or "USD",
            "imageUrl": image or "",
            "platform": platform,
            "description": description or "",
            "features": features or []
        }

    return None

def scrape_with_requests(url, platform):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, "html.parser")
            return parse_html(soup, platform)
    except Exception as e:
        print(f"Requests error: {e}")
    return None

def scrape_with_selenium(url, platform):
    if not SELENIUM_AVAILABLE:
        return None
    
    driver = None
    try:
        chrome_opts = ChromeOptions()
        chrome_opts.add_argument("--headless")
        chrome_opts.add_argument("--no-sandbox")
        chrome_opts.add_argument("--disable-dev-shm-usage")
        chrome_opts.add_argument("--disable-gpu")
        
        driver = webdriver.Chrome(options=chrome_opts)
        driver.set_page_load_timeout(30)
        driver.get(url)
        
        # Wait for price or title
        time.sleep(5)
        
        html = driver.page_source
        soup = BeautifulSoup(html, "html.parser")
        return parse_html(soup, platform)
    except Exception as e:
        print(f"Selenium error: {e}")
        return None
    finally:
        if driver:
            driver.quit()

def clean_archive_url(url):
    clean = url.strip()
    clean = clean.replace("://dl.flipkart.com/dlhttp://", "://").replace("://dl.flipkart.com/dlhttps://", "://")
    clean = re.sub(r'/gp/aw/d/', '/dp/', clean)
    clean = clean.replace('//m.flipkart.com/', '//www.flipkart.com/').replace('dl.flipkart.com/dl/', 'www.flipkart.com/')
    asin_match = re.search(r'/(?:dp|gp/product)/([A-Z0-9]{10})', clean, re.I)
    if asin_match and 'amazon' in clean.lower():
        asin = asin_match.group(1)
        domain = 'amazon.in' if 'amazon.in' in clean.lower() else 'amazon.com'
        clean = f"https://www.{domain}/dp/{asin}"
    return clean

def fetch_original_price_history(url, current_price=None, days=180):
    """
    Fetches authentic past prices for a product from public historical price archives.
    Projects continuous daily prices for up to 180 days.
    """
    try:
        clean_url = clean_archive_url(url)
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Content-Type': 'application/json',
            'Referer': 'https://pricehistory.app/'
        }

        # 1. Search for indexed code
        resp = requests.post(
            'https://pricehistory.app/api/search',
            json={'url': clean_url},
            headers=headers,
            timeout=12
        )
        if resp.status_code != 200:
            return None
        search_data = resp.json()
        if not search_data.get('status') or not search_data.get('code'):
            return None

        code = search_data['code']
        page_url = f"https://pricehistory.app/p/{code}"

        # 2. Fetch page HTML
        page_resp = requests.get(page_url, headers=headers, timeout=12)
        if page_resp.status_code != 200:
            return None

        page_html = page_resp.text

        # 3. Extract and decrypt dataset
        match_data = re.search(r'var\s+PagePriceHistoryDataSet\s*=\s*[\'"]([^\'"]+)[\'"]', page_html)
        match_key = re.search(r'(?:let|var)\s+CachedKey\s*=\s*[\'"]([^\'"]+)[\'"]', page_html)
        if not match_data or not match_key:
            return None

        raw_b64 = match_data.group(1)
        key = match_key.group(1)

        decoded_bytes = base64.b64decode(raw_b64)
        key_bytes = key.encode('utf-8')
        result_bytes = bytearray()
        for i, b in enumerate(decoded_bytes):
            result_bytes.append(b ^ key_bytes[i % len(key_bytes)])

        dataset = json.loads(result_bytes.decode('utf-8'))
        raw_history = dataset.get('History', {}).get('Price', [])
        if not isinstance(raw_history, list) or not raw_history:
            return None

        price_by_date = {}
        for entry in raw_history:
            p = entry.get('y')
            d = entry.get('x')
            if p is not None and d:
                price_by_date[d] = float(p)

        if not price_by_date:
            return None

        sorted_dates = sorted(price_by_date.keys())
        today = datetime.now().date()
        start_date = today - timedelta(days=days)
        start_date_str = start_date.strftime('%Y-%m-%d')

        prior_price = None
        for d_str in sorted_dates:
            if d_str <= start_date_str:
                prior_price = price_by_date[d_str]
            else:
                break

        if prior_price is None:
            prior_price = price_by_date[sorted_dates[0]]

        history = []
        running_price = prior_price

        for i in range(days + 1):
            target_date = start_date + timedelta(days=i)
            target_str = target_date.strftime('%Y-%m-%d')
            if target_str in price_by_date:
                running_price = price_by_date[target_str]

            history.append({
                'price': running_price,
                'date': target_date.isoformat()
            })

        if current_price and history:
            history[-1]['price'] = float(current_price)

        return history
    except Exception as e:
        print(f"fetch_original_price_history notice: {e}")
        return None

@app.route("/scrape", methods=["POST"])
def scrape():
    try:
        data = request.get_json()
        url = data.get("url")
        if not url:
            return jsonify({"error": "URL required"}), 400

        platform = detect_platform(url)
        print(f"Scraping {url} (Platform: {platform})")

        # Try requests first for speed
        result = scrape_with_requests(url, platform)
        
        # Fallback to Selenium if requests failed or returned incomplete data
        if not result and SELENIUM_AVAILABLE:
            print("Requests failed, trying Selenium fallback...")
            result = scrape_with_selenium(url, platform)

        if result:
            # Attempt to fetch authentic original historical prices (180 days)
            try:
                original_history = fetch_original_price_history(url, result.get("price"), 180)
                if original_history:
                    result["priceHistory"] = original_history
                    result["isAuthenticHistory"] = True
                    print(f"Attached {len(original_history)} authentic original past prices to response.")
                else:
                    result["priceHistory"] = []
                    result["isAuthenticHistory"] = False
            except Exception as hist_err:
                print(f"Price history retrieval notice: {hist_err}")
                result["priceHistory"] = []
                result["isAuthenticHistory"] = False

            return jsonify(result), 200
        
        return jsonify({"error": "Failed to extract product data. The page might be protected or the structure has changed."}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/history", methods=["POST"])
def history_endpoint():
    try:
        data = request.get_json() or {}
        url = data.get("url")
        current_price = data.get("currentPrice")
        days = int(data.get("days", 180))
        if not url:
            return jsonify({"error": "URL required"}), 400

        history = fetch_original_price_history(url, current_price, days)
        if history:
            return jsonify({"success": True, "history": history, "count": len(history)}), 200
        return jsonify({"success": False, "message": "No archive history available for this URL"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/health")
def health():
    return jsonify({"status": "ok", "selenium": SELENIUM_AVAILABLE}), 200

if __name__ == "__main__":
    print("="*60)
    print("Refactored Scraper Service running on port 5001")
    print(f"Selenium available: {SELENIUM_AVAILABLE}")
    print("="*60)
    app.run(host="0.0.0.0", port=5001, debug=True)
