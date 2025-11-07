# 🚀 AL BOURAKH MAPS - DÉPLOIEMENT VERCEL

## 📁 Contenu du dossier

- **index.html** - Application complète avec Google Maps
- **vercel.json** - Configuration Vercel
- **README.md** - Ce fichier

## 🎯 INSTRUCTIONS DE DÉPLOIEMENT

### ÉTAPE 1 : Créer un nouveau dépôt GitHub

1. Allez sur https://github.com
2. Cliquez sur **"New repository"**
3. Nom : **`albourakh-maps`**
4. Public ou Private (au choix)
5. **NE PAS** initialiser avec README
6. Cliquez **"Create repository"**

### ÉTAPE 2 : Uploader les fichiers

**Méthode simple (via interface GitHub) :**

1. Sur la page de votre nouveau repo, cliquez **"uploading an existing file"**
2. **Glissez-déposez** les 2 fichiers :
   - `index.html`
   - `vercel.json`
3. Commit message : "Initial commit - Al Bourakh Maps"
4. Cliquez **"Commit changes"**

### ÉTAPE 3 : Déployer sur Vercel

1. Allez sur https://vercel.com/dashboard
2. Cliquez **"Add New..." → "Project"**
3. Sélectionnez votre repo **`albourakh-maps`**
4. Cliquez **"Import"**
5. **Laissez tous les paramètres par défaut**
6. Cliquez **"Deploy"**

### ⏱️ Temps de déploiement

- **30 secondes à 1 minute**
- Vous verrez des confettis ! 🎉

### ✅ Résultat

Votre site sera accessible à :
```
https://albourakh-maps.vercel.app
```

ou un nom similaire généré par Vercel.

---

## 🔧 Configuration Google Maps

La clé API est déjà incluse dans le fichier :
```
AIzaSyB0S4bvgw9zQgqRiyW0vwxDi1lp9m35MI8
```

**⚠️ IMPORTANT : Autorisez votre domaine Vercel**

1. Allez sur https://console.cloud.google.com
2. **APIs et services** → **Identifiants**
3. Cliquez sur votre clé API
4. **Restrictions d'application** → Ajoutez :
   ```
   https://*.vercel.app/*
   ```
5. **Enregistrer**
6. **Attendez 5 minutes** pour la propagation

---

## ✨ Fonctionnalités incluses

✅ Navigation GPS en temps réel
✅ Recherche d'adresses avec autocomplétion
✅ 118+ zones de Dakar
✅ Markers interactifs
✅ Géolocalisation utilisateur
✅ Design 100% responsive
✅ Optimisé pour mobile

---

## 📞 Support

En cas de problème :
- Vérifiez la console (F12)
- Assurez-vous que la clé API est autorisée
- Attendez 5-10 minutes après changement de restrictions

---

**Bon déploiement ! 🚀**

Al Bourakh - La Foudre ⚡
